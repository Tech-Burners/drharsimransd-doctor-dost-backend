import { Server as SocketIOServer, Socket } from 'socket.io'
import { Server as HttpServer } from 'http'
import express, { Application } from 'express'
import httpStatus from 'http-status'
import AppError from './app/error/AppError'
import config from './app/config'
import mongoose from 'mongoose'
import { callbackFn } from './app/utils/callbackFn'
// import Chat from './app/modules/chat/chat.model'
import moment from 'moment-timezone'
// import Message from './app/modules/message/message.model'
// import { ChatService } from './app/modules/chat/chat.service'
import { Notification } from './app/modules/notification/notification.model'
import { TNotificationType } from './app/modules/notification/notification.interface'
import { User } from './app/modules/user/user.model'
import { sendEmail } from './app/utils/mailSender'
import { createAdapter } from '@socket.io/redis-adapter'
import { verifyAccessToken } from './app/middleware/auth'
import { createRedisConnection } from './shared/redis'
import { setRealtimeEmitter, userRoom } from './shared/realtime'
import { logger } from './shared/logger'
import { registerPresenceHandlers } from './app/modules/presence/presence.socket'

// Define the socket server port
const socketPort: number = parseInt(process.env.SOCKET_PORT || '9020', 10)

const app: Application = express()

declare module 'socket.io' {
  interface Socket {
    user?: {
      _id: string
      name: string
      email: string
      role: string
    }
  }
}

// Initialize the Socket.IO server
let io: SocketIOServer

export const connectedUsers = new Map<
  string,
  {
    socketID: string
  }
>()

export const initSocketIO = async (server: HttpServer): Promise<void> => {
  const { Server } = await import('socket.io')

  io = new Server(server, {
    cors: {
      origin: '*', // Replace with your client's origin
      methods: ['GET', 'POST'],
      allowedHeaders: ['my-custom-header'], // Add any custom headers if needed
      credentials: true,
    },
  })

  // Multi-instance: with the Redis adapter a doctor connected to instance A receives an event
  // emitted from instance B. Required from day one, not when a second instance is added.
  if (config.redis_url) {
    const pub = createRedisConnection()
    io.adapter(createAdapter(pub, pub.duplicate()))
  }
  // Services emit to rooms (user:<id>), never to a single instance's socket map.
  setRealtimeEmitter({
    emitToUser: (userId, event, payload) => {
      io.to(userRoom(userId)).emit(event, payload)
    },
  })

  // Start the HTTP server on the specified port
  server.listen(socketPort, () => {
    console.log(
      //@ts-ignore
      `---> DoctorDost socket is listening on  : http://${config.ip}:${config.socket_port}`
        .yellow.bold
    )
  })

  // Authentication middleware: now takes the token from headers.
  io.use(async (socket: Socket, next: (err?: any) => void) => {
    // Extract token from headers (ensure your client sends it in headers)
    const token =
      (socket.handshake.auth.token as string) ||
      (socket.handshake.headers.token as string) ||
      (socket.handshake.headers.authorization as string)

    if (!token) {
      return next(
        new AppError(
          httpStatus.UNAUTHORIZED,
          'Authentication error: Token missing'
        )
      )
    }

    // The same checks as the HTTP middleware: signature, expiry, token type, tokenVersion and
    // account status. Reset / signup tokens (signed with related secrets) are refused.
    let userDetails
    try {
      userDetails = await verifyAccessToken(token.startsWith('Bearer ') ? token.slice(7) : token)
    } catch (err) {
      logger.warn({ err }, 'socket handshake rejected')
      return next(new Error('Authentication error: Invalid token'))
    }

    const user = await User.findById(userDetails.userId)
    if (!user) {
      return next(new Error('Authentication error: User not found'))
    }

    socket.user = {
      _id: user._id.toString(), // Convert _id to string if necessary
      name: user.name as string,
      email: user.email,
      role: user.role,
    }
    next()
  })

  io.on('connection', (socket: Socket) => {
    // =================== try catch 1 start ================
    try {
      // Every socket joins the room events are addressed to (reachable across instances).
      if (socket.user) {
        void socket.join(userRoom(socket.user._id))
        registerPresenceHandlers(io, socket)
      }

      // Automatically register the connected user to avoid missing the "userConnected" event.
      if (socket.user && socket.user._id) {
        connectedUsers.set(socket.user._id.toString(), { socketID: socket.id })
        console.log(
          `Registered user ${socket.user._id.toString()} with socket ID: ${socket.id}`
        )
      }

      // (Optional) In addition to auto-registering, you can still listen for a "userConnected" event if needed.
      socket.on('userConnected', ({ userId }: { userId: string }) => {
        connectedUsers.set(userId, { socketID: socket.id })
        // console.log(`User ${userId} connected with socket ID: ${socket.id}`)
      })


      //-----------------------Disconnect functionlity start ------------------------//
      socket.on('disconnect', () => {
        console.log(
          `${socket.user?.name} || ${socket.user?.email} || ${socket.user?._id} just disconnected with socket ID: ${socket.id}`
        )

      })
      //-----------------------Disconnect functionlity end ------------------------//
    } catch (error) {
      console.error('-- socket.io connection error --', error)

      // throw new Error(error)
      //-----------------------Disconnect functionlity start ------------------------//
      socket.on('disconnect', () => {
        console.log(
          `${socket.user?.name} || ${socket.user?.email} || ${socket.user?._id} just disconnected with socket ID: ${socket.id}`
        )

        // Remove user from connectedUsers map
        for (const [key, value] of connectedUsers.entries()) {
          if (value.socketID === socket.id) {
            connectedUsers.delete(key)
            break
          }
        }
        // io.emit('onlineUser', Array.from(connectedUsers));
        io.emit('onlineUser', Array.from(connectedUsers.keys()))
      })
      //-----------------------Disconnect functionlity end ------------------------//
    }
    // ==================== try catch 1 end ==================== //
  })
}

// Export the Socket.IO instance
export { io }

export const emitNotification = async ({
  senderId,
  receiverId,
  title,
  message,
  type,
  data = {},
  receiverEmail,
  emailSubject,
  emailHtml,
}: {
  senderId: mongoose.Types.ObjectId
  receiverId: mongoose.Types.ObjectId
  title: string
  message: string,
  type: TNotificationType,
  data?: Record<string, unknown>

  receiverEmail?: string
  emailSubject?: string
  emailHtml?: string
}): Promise<void> => {
  if (!io) {
    throw new Error('Socket.IO is not initialized')
  }

  // Get the socket ID of the specific user
  const userSocket = connectedUsers.get(receiverId.toString())

  // Fetch unread notifications count for the receiver before creating the new notification
  const unreadCount = await Notification.countDocuments({
    userId: receiverId,
    readAt: null, // Filter by unread notifications
  })

  // Notify the specific user
  if (message && userSocket) {
    io.to(userSocket.socketID).emit(`notification`, {
      // userId,
      // message: userMsg,
      statusCode: 200,
      success: true,
      unreadCount: unreadCount >= 0 ? unreadCount + 1 : 1,
    })
  }

  // Save notification to the database
  await Notification.create({
    userId: receiverId,
    type,
    title,
    body: message,
    data: { ...data, senderId },
  })


  // 📧 Send Email (optional)
  if (receiverEmail && emailSubject && emailHtml) {
    await sendEmail(receiverEmail, emailSubject, emailHtml)
  }

}
