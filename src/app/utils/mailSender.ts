import nodemailer from 'nodemailer'
import config from '../config'




// Go Daddy business email setup for the node mailer
export const sendEmail = async (to: string, subject: string, html: string) => {


  
  
  const transporter = nodemailer.createTransport({
    host: 'smtpout.secureserver.net',
    port: 465,
    secure: true, // SSL/TLS
    auth: {
      user: config.nodemailer_host_email, 
      pass: config.nodemailer_host_pass,  // SMTP app password if needed
    },
  });

  try {
    console.log('mail send started =>>>> ');
    await transporter.sendMail({
      from: `"DoctorDost Ltd " <${config.nodemailer_host_email}>`,
      to,
      subject,
      text: '',
      html,
    });
    console.log('mail sent successfully');
  } catch (error) {
    console.error('send mail error:', error);
  }
};



// export const sendEmail = async (to: string, subject: string, html: string) => {

//   const transporter = nodemailer.createTransport({
//     host: 'smtp.gmail.com',
//     port: 587,
//     secure: config.NODE_ENV === 'production',
//     auth: {
//       // TODO: replace `user` and `pass` values from <https://forwardemail.net>
//       user: config.nodemailer_host_email,
//       pass: config.nodemailer_host_pass,
//     },
//   });

  
//   try {
//     console.log('mail send started');
//     await transporter.sendMail({
//       from: 'team.robust.dev@gmail.com', // sender address
//       to, // list of receivers
//       subject,
//       text: '', // plain text body
//       html, // html body
//     });
    
//     console.log('mail sended successfully');
    
//   } catch (error) {
//     console.log('send mail error:', error);
    
//   }
//   console.log('mail sended stopped');
// };

// const transporter = nodemailer.createTransport({
//   host: "mail.websupport.sk", // sending SMTP server
//   port: 465,              // SSL port
//   secure: true,           // true for port 465
//   auth: {
//     user: "cvak@frafol.sk",        // your email
//     pass: "GgsNPK@$Ooj6c9uB"    // SMTP/webmail password
//   },
//   tls: {
//     rejectUnauthorized: false  // ⚠️ disables certificate validation
//   }
// });