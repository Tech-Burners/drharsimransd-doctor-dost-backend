import httpStatus from "http-status";
import AppError from "../../error/AppError";
import { sendEmail } from "../../utils/mailSender";
import config from "../../config";

interface ContactUsPayload {
  name: string;
  companyName?: string; // optional
  email: string;
  phone: string;
  message: string;
}

const contactUs = async (payload: ContactUsPayload) => {
  const { name, companyName, email, phone, message } = payload;

  // Basic validation
  if (!name || !email || !phone || !message) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Name, email, phone, and message are required"
    );
  }

  try {
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h3>📩 New Contact Form Submission</h3>

        <p><strong>Name:</strong> ${name}</p>
        ${
          companyName
            ? `<p><strong>Company Name:</strong> ${companyName}</p>`
            : ""
        }
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone}</p>

        <p><strong>Message:</strong></p>
        <p>${message}</p>

        <hr />
        <small>This message was received from your website contact form.</small>
      </div>
    `;


    // Send email to admin
    await sendEmail(
      config.contact_email as string,
      `New Contact Message from ${name}`,
      html
    );

    return {
      message: "Your message has been sent successfully",
    };
  } catch (error) {
    console.error("Contact Us Email Error:", error);

    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Failed to send message. Please try again later."
    );
  }
};

export const ContactService = {
  contactUs,
};