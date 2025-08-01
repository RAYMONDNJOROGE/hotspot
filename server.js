// 1. Load Environment Variables - Always at the very top
require("dotenv").config();

// 2. Import Required Modules
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const helmet = require("helmet");
const morgan = require("morgan");
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");
const { Ssh2Promise } = require("ssh2-promise"); // Added SSH library

const app = express();
const PORT = process.env.PORT || 3000;

// --- Custom Error Class and Centralized Handler ---
class APIError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

// --- M-Pesa API Configuration from Environment Variables ---
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_BUSINESS_SHORTCODE = process.env.MPESA_BUSINESS_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;
const MPESA_API_BASE_URL =
  process.env.MPESA_API_BASE_URL || "https://sandbox.safaricom.co.ke";

// --- Email Service Configuration from Environment Variables ---
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_RECIPIENT = process.env.EMAIL_RECIPIENT;

// --- Mikrotik SSH Configuration from Environment Variables ---
const MIKROTIK_HOST = process.env.MIKROTIK_HOST;
const MIKROTIK_PORT = process.env.MIKROTIK_PORT || 22;
const MIKROTIK_USERNAME = process.env.MIKROTIK_USERNAME;
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD;

// --- MongoDB Connection String (from .env) ---
const MONGODB_URI = process.env.MONGODB_URI;

// --- Critical Environment Variable Check ---
const requiredEnvVars = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_BUSINESS_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL",
  "MONGODB_URI",
  "EMAIL_USER",
  "EMAIL_PASS",
  "EMAIL_RECIPIENT", // Added Mikrotik environment variables
  "MIKROTIK_HOST",
  "MIKROTIK_USERNAME",
  "MIKROTIK_PASSWORD",
];

const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(
    `CRITICAL ERROR: The following required environment variables are missing: ${missingEnvVars.join(
      ", "
    )}`
  );
  process.exit(1);
}

// --- Connect to MongoDB ---
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("[DB] Connected to MongoDB successfully."))
  .catch((err) => {
    console.error("[DB] MongoDB initial connection error:", err.message);
    process.exit(1);
  });

// --- Define Mongoose Schema and Model for Payments ---
const paymentSchema = new mongoose.Schema(
  {
    MerchantRequestID: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    CheckoutRequestID: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    ResultCode: { type: Number, index: true },
    ResultDesc: { type: String },
    Amount: { type: Number },
    MpesaReceiptNumber: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    TransactionDate: { type: Date },
    PhoneNumber: { type: String },
    packageDescription: { type: String }, // ADDED: New field to store the user's MAC address
    macAddress: { type: String, default: null },
    status: {
      type: String,
      default: "Pending",
      enum: [
        "Pending",
        "Completed",
        "Failed",
        "Cancelled",
        "Processing",
        "Timeout",
      ],
    },
    RawCallbackData: { type: mongoose.Schema.Types.Mixed },
    expiresAt: { type: Date },
  },
  { timestamps: true, strict: true }
);

paymentSchema.pre("save", function (next) {
  if (this.MpesaReceiptNumber === "") {
    this.MpesaReceiptNumber = undefined;
  }
  next();
});

const Payment = mongoose.model("Payment", paymentSchema);

// --- Middleware Configuration ---
app.use(helmet());
const allowedOrigins =
  process.env.NODE_ENV === "production"
    ? ["https://hotspot-gved.onrender.com"]
    : ["http://localhost:3000", "http://localhost:5500"];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}.`;
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  })
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// --- Helper for Phone Number Normalization and Validation ---
function normalizePhoneNumber(phone) {
  phone = String(phone).trim();
  const kenyanPhoneRegex = /^(0(1|7)\d{8}|254(1|7)\d{8})$/;
  if (!kenyanPhoneRegex.test(phone)) return null;
  if (phone.startsWith("0")) return "254" + phone.substring(1);
  return phone;
}

// --- Nodemailer transporter setup ---
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

// --- Mikrotik SSH Client Setup ---
const sshConfig = {
  host: MIKROTIK_HOST,
  port: parseInt(MIKROTIK_PORT),
  username: MIKROTIK_USERNAME,
  password: MIKROTIK_PASSWORD,
};
const ssh = new Ssh2Promise(sshConfig);

/**
 * Creates a Mikrotik hotspot user with a specific profile.
 * @param {string} username - The username (e.g., phone number).
 * @param {string} macAddress - The user's MAC address.
 * @param {string} profile - The Mikrotik profile name (e.g., a package name).
 * @returns {Promise<boolean>} True if user was added, false otherwise.
 */
async function addMikrotikUser(username, macAddress, profile) {
  try {
    await ssh.connect();
    const command = `/ip hotspot user add name="${username}" mac-address="${macAddress}" profile="${profile}" limit-uptime="${getDurationFromProfile(
      profile
    )}"`;
    const result = await ssh.exec(command);
    console.log(`[Mikrotik] User added: ${username} with profile ${profile}.`);
    return true;
  } catch (error) {
    console.error(`[Mikrotik] Failed to add user ${username}:`, error.message);
    return false;
  } finally {
    if (ssh.conn && ssh.conn.connected) {
      ssh.close();
    }
  }
}

function getDurationFromProfile(profile) {
  if (profile.includes("3-Hour")) return "3h";
  if (profile.includes("7-Hour")) return "7h";
  if (profile.includes("14-Hour")) return "14h";
  if (profile.includes("24-Hour")) return "24h";
  if (profile.toLowerCase().includes("unlimited")) return "24h";
  return "1h"; // Default to 1 hour
}

// --- API Routes ---

// M-Pesa Payment Initiation API Endpoint
app.post("/api/process_payment", async (req, res, next) => {
  // Your existing M-Pesa payment initiation logic
  try {
    let { amount, phone, packageDescription } = req.body;
    if (!amount || !phone || !packageDescription) {
      throw new APIError(
        "Missing required payment details: amount, phone, or package description.",
        400
      );
    }
    amount = parseFloat(amount);
    if (isNaN(amount) || amount <= 0) {
      throw new APIError(
        "Invalid amount provided. Amount must be a positive number.",
        400
      );
    }
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      throw new APIError(
        "Invalid phone number format. Please use a valid Kenyan mobile number (e.g., 07XXXXXXXX or 01XXXXXXXX).",
        400
      );
    }
    phone = normalizedPhone;

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);
    const auth = Buffer.from(
      `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
    ).toString("base64");

    const tokenResponse = await fetch(
      `${MPESA_API_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      { method: "GET", headers: { Authorization: `Basic ${auth}` } }
    );
    if (!tokenResponse.ok) {
      const tokenError = await tokenResponse
        .json()
        .catch(() => ({ message: "Failed to parse M-Pesa token error" }));
      throw new APIError(
        "Failed to authenticate with M-Pesa. Please try again later.",
        tokenResponse.status,
        process.env.NODE_ENV !== "production" ? tokenError : undefined
      );
    }
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      throw new APIError(
        "M-Pesa authentication failed unexpectedly: No access token received.",
        500
      );
    }

    const password = Buffer.from(
      `${MPESA_BUSINESS_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString("base64");
    const stkPushPayload = {
      BusinessShortCode: MPESA_BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: MPESA_BUSINESS_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: packageDescription,
      TransactionDesc: `Payment for ${packageDescription} via Raynger Hotspot Services`,
    };

    const stkPushResponse = await fetch(
      `${MPESA_API_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(stkPushPayload),
      }
    );
    const stkPushData = await stkPushResponse.json();

    if (stkPushData.ResponseCode === "0") {
      // Only save if STK push was accepted (not payment success yet)
      const newPayment = new Payment({
        MerchantRequestID: stkPushData.MerchantRequestID,
        CheckoutRequestID: stkPushData.CheckoutRequestID,
        status: "Processing",
        Amount: amount,
        PhoneNumber: phone,
        packageDescription: packageDescription,
      });
      await newPayment.save();

      res.status(200).json({
        success: true,
        message:
          "Payment request sent successfully. Please complete the transaction on your phone.",
        customerMessage:
          stkPushData.CustomerMessage || "Awaiting user payment confirmation.",
        checkoutRequestID: stkPushData.CheckoutRequestID,
      });
    } else {
      // Do NOT save failed payment attempts
      const errorMessage =
        stkPushData.CustomerMessage ||
        stkPushData.ResponseDescription ||
        stkPushData.errorMessage ||
        "Unknown error from M-Pesa during STK push initiation.";
      throw new APIError(
        `Payment initiation failed: ${errorMessage}`,
        400,
        process.env.NODE_ENV !== "production" ? stkPushData : undefined
      );
    }
  } catch (error) {
    next(error);
  }
});

// M-Pesa Callback URL - Only update if payment was successful
app.post("/api/mpesa_callback", async (req, res) => {
  const callbackData = req.body;
  res.status(200).json({ MpesaResponse: "Callback received" }); // Your existing M-Pesa callback logic
  setImmediate(async () => {
    try {
      if (!callbackData.Body || !callbackData.Body.stkCallback) {
        console.error(
          "Invalid M-Pesa callback format: Missing Body or stkCallback."
        );
        return;
      }
      const stkCallback = callbackData.Body.stkCallback;
      const merchantRequestID = stkCallback.MerchantRequestID;
      const checkoutRequestID = stkCallback.CheckoutRequestID;
      const resultCode = stkCallback.ResultCode;

      if (resultCode === 0) {
        // Only update if payment was successful
        const updateFields = {
          ResultCode: resultCode,
          ResultDesc:
            stkCallback.ResultDesc || "No specific description provided.",
          RawCallbackData: callbackData,
          status: "Completed",
        };

        const callbackMetadata = stkCallback.CallbackMetadata;
        if (callbackMetadata && callbackMetadata.Item) {
          callbackMetadata.Item.forEach((item) => {
            if (item.Name === "Amount") updateFields.Amount = item.Value;
            if (item.Name === "MpesaReceiptNumber")
              updateFields.MpesaReceiptNumber = item.Value;
            if (item.Name === "TransactionDate") {
              const dateString = item.Value;
              if (dateString && dateString.length === 14) {
                const year = dateString.substring(0, 4);
                const month = dateString.substring(4, 6) - 1;
                const day = dateString.substring(6, 8);
                const hour = dateString.substring(8, 10);
                const minute = dateString.substring(10, 12);
                const second = dateString.substring(12, 14);
                updateFields.TransactionDate = new Date(
                  Date.UTC(year, month, day, hour, minute, second)
                );
              }
            }
            if (item.Name === "PhoneNumber")
              updateFields.PhoneNumber = item.Value;
          });
        } // Set expiresAt based on plan
        let durationHours = 1;
        const desc = updateFields.packageDescription || "";
        if (desc.includes("3-Hour")) durationHours = 3;
        else if (desc.includes("7-Hour")) durationHours = 7;
        else if (desc.includes("14-Hour")) durationHours = 14;
        else if (desc.includes("24-Hour")) durationHours = 24;
        if (desc.toLowerCase().includes("unlimited")) durationHours = 24;
        updateFields.expiresAt = new Date(
          Date.now() + durationHours * 60 * 60 * 1000
        );

        const query = {
          $or: [
            { CheckoutRequestID: checkoutRequestID },
            { MerchantRequestID: merchantRequestID },
          ],
        };

        const updatedPayment = await Payment.findOneAndUpdate(
          query,
          { $set: updateFields },
          { new: true, upsert: false, runValidators: true }
        );

        if (updatedPayment) {
          console.log(
            `Payment record updated for CheckoutRequestID ${checkoutRequestID}. Status: ${updatedPayment.status}`
          );
          if (updatedPayment.status === "Completed") {
            console.log(
              `[Service Fulfillment] Payment for ${updatedPayment.MpesaReceiptNumber} completed. Fulfilling service for ${updatedPayment.PhoneNumber}.`
            );
          }
        } else {
          console.warn(
            `[DB Issue] No existing payment found for CheckoutRequestID ${checkoutRequestID}.`
          );
        }
      } else {
        // Do NOT update or create payment for failed/cancelled payments
        console.log(
          `Payment not successful for CheckoutRequestID ${checkoutRequestID}. ResultCode: ${resultCode}`
        );
      }
    } catch (error) {
      console.error(
        "CRITICAL: Error processing M-Pesa callback (async background job):",
        error
      );
    }
  });
});

// Endpoint for frontend to check the status of a specific payment
app.get(
  "/api/check_payment_status/:checkoutRequestID",
  async (req, res, next) => {
    // Your existing payment status check logic
    try {
      const { checkoutRequestID } = req.params;
      if (!checkoutRequestID)
        throw new APIError("CheckoutRequestID is required.", 400);

      const payment = await Payment.findOne({
        CheckoutRequestID: checkoutRequestID,
      });
      if (!payment) {
        return res.status(200).json({
          success: true,
          status: "Processing",
          message: "Payment record not found. Awaiting callback.",
        });
      }

      const responseStatus = payment.status;
      let responseMessage = "Status is pending.";
      if (responseStatus === "Completed") {
        responseMessage =
          "Your payment was successful. Kindly wait for service fulfillment.";
      } else if (responseStatus === "Cancelled") {
        responseMessage = "You cancelled the M-Pesa payment prompt.";
      } else if (responseStatus === "Failed") {
        responseMessage = "The M-Pesa payment failed. Please try again.";
      } else if (responseStatus === "Timeout") {
        responseMessage = "The M-Pesa payment timed out. Please try again.";
      }

      res.status(200).json({
        success: true,
        status: responseStatus,
        message: responseMessage,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ADDED: Endpoint for frontend to trigger Mikrotik login after payment success
app.post("/api/mikrotik_auth", async (req, res, next) => {
  try {
    const { phoneNumber, macAddress, package } = req.body;
    if (!phoneNumber || !macAddress || !package) {
      throw new APIError(
        "Missing required parameters: phoneNumber, macAddress, or package.",
        400
      );
    }

    // Find the most recent successful payment for this user/package
    const payment = await Payment.findOne({
      PhoneNumber: phoneNumber,
      packageDescription: package,
      status: "Completed",
    }).sort({ createdAt: -1 });

    if (!payment) {
      throw new APIError(
        "No completed payment found for this user/package combination.",
        404
      );
    }

    // Add the user to Mikrotik via SSH
    const success = await addMikrotikUser(phoneNumber, macAddress, package);

    if (success) {
      // Update the payment record with the MAC address after successful Mikrotik login
      await Payment.findByIdAndUpdate(payment._id, { $set: { macAddress } });
      res
        .status(200)
        .json({ success: true, message: "User authenticated on Mikrotik." });
    } else {
      throw new APIError(
        "Failed to authenticate user on Mikrotik. Check router logs.",
        500
      );
    }
  } catch (error) {
    next(error);
  }
});

// Endpoint to retrieve all payments (SECURE THIS!)
app.get("/api/payments", async (req, res, next) => {
  // Your existing payments endpoint logic
  if (
    process.env.NODE_ENV === "production" &&
    (!req.headers.authorization ||
      !req.headers.authorization.startsWith("Bearer "))
  ) {
    return next(new APIError("Authentication required.", 401));
  }
  try {
    const {
      page = 1,
      limit = 10,
      status,
      sort = "createdAt",
      order = -1,
    } = req.query;
    const query = status ? { status } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOrder = parseInt(order);

    const payments = await Payment.find(query)
      .sort({ [sort]: sortOrder })
      .skip(skip)
      .limit(parseInt(limit));
    const totalPayments = await Payment.countDocuments(query);

    res.json({
      success: true,
      data: payments,
      meta: {
        total: totalPayments,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalPayments / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching payments:", error);
    next(error);
  }
});

// Endpoint to receive comments and send an email
app.post("/api/submit_comment", async (req, res, next) => {
  // Your existing comments endpoint logic
  try {
    const { firstName, secondName, phone, email, commentsText } = req.body;
    if (!commentsText) {
      return next(new APIError("Comment text is required.", 400));
    }
    const mailOptions = {
      from: EMAIL_USER,
      to: EMAIL_RECIPIENT,
      subject: `New Comment from ${firstName || "Anonymous"} ${
        secondName || ""
      }`,
      html: `
        <h2>New Comment Submission</h2>
        <p><strong>First Name:</strong> ${firstName || "N/A"}</p>
        <p><strong>Second Name:</strong> ${secondName || "N/A"}</p>
        <p><strong>Phone:</strong> ${phone || "N/A"}</p>
        <p><strong>E-mail:</strong> ${email || "N/A"}</p>
        <p><strong>Comments:</strong><br>${
        commentsText || "No comments provided."
      }</p>
      `,
    };
    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: %s", info.messageId);

    res
      .status(200)
      .json({ success: true, message: "Comment submitted successfully!" });
  } catch (error) {
    console.error("Error sending email:", error);
    next(
      new APIError(
        "Failed to send comment. Please try again later.",
        500,
        error
      )
    );
  }
});

// --- Centralized Error Handling Middleware ---
app.use((err, req, res, next) => {
  // Your existing error handling logic
  const logLevel = err.statusCode && err.statusCode < 500 ? "warn" : "error";
  if (process.env.NODE_ENV !== "production") {
    console[logLevel]("Unhandled Server Error (DEV):", err.stack || err);
  } else {
    console[logLevel]("Unhandled Server Error (PROD):", err.message, {
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
  }

  let statusCode = 500;
  let message = "An internal server error occurred. Please try again later.";
  let errorDetails = undefined;

  if (err instanceof APIError) {
    statusCode = err.statusCode;
    message = err.message;
    if (process.env.NODE_ENV !== "production") {
      errorDetails = err.details;
    }
  } else if (err.name === "ValidationError" && err.errors) {
    statusCode = 400;
    message = "Data validation failed.";
    errorDetails = Object.values(err.errors).map((val) => val.message);
  } else if (err.name === "CastError" && err.path) {
    statusCode = 400;
    message = `Invalid format for ${err.path}.`;
  }

  res.status(statusCode).json({
    success: false,
    message: message,
    error: errorDetails,
  });
});

// MikroTik API: Check if a phone number has a valid, unexpired payment
app.get("/api/mikrotik/check_payment", async (req, res, next) => {
  // Your existing Mikrotik check payment logic
  try {
    const { phone } = req.query;
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: "Phone number is required." });
    }
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid phone number format." });
    } // Find the most recent successful payment
    const payment = await Payment.findOne({
      PhoneNumber: normalizedPhone,
      status: "Completed",
    }).sort({ createdAt: -1 });

    if (payment) {
      // Calculate expiry based on plan (example logic)
      let durationHours = 1;
      if (payment.packageDescription.includes("3-Hour")) durationHours = 3;
      else if (payment.packageDescription.includes("7-Hour")) durationHours = 7;
      else if (payment.packageDescription.includes("14-Hour"))
        durationHours = 14;
      else if (payment.packageDescription.includes("24-Hour"))
        durationHours = 24;
      if (payment.packageDescription.toLowerCase().includes("unlimited"))
        durationHours = 24; // Use expiresAt from DB if available, otherwise calculate

      let expiresAt = payment.expiresAt
        ? new Date(payment.expiresAt)
        : new Date(
            payment.createdAt.getTime() + durationHours * 60 * 60 * 1000
          );
      const now = new Date(); // Bandwidth logic: determine speed profile

      let bandwidth = "default";
      if (payment.packageDescription.toLowerCase().includes("unlimited")) {
        bandwidth = "unlimited";
      } else if (
        payment.packageDescription.toLowerCase().includes("3mbps") ||
        payment.packageDescription.toLowerCase().includes("vybz")
      ) {
        bandwidth = "3mbps";
      }

      if (now < expiresAt) {
        return res.json({
          success: true,
          paid: true,
          amount: payment.Amount,
          plan: payment.packageDescription,
          bandwidth,
          paidAt: payment.createdAt,
          expiresAt,
          receipt: payment.MpesaReceiptNumber,
        });
      } else {
        return res.json({
          success: true,
          paid: false,
          message: "Subscription expired.",
        });
      }
    } else {
      return res.json({ success: true, paid: false });
    }
  } catch (error) {
    next(error);
  }
});

// --- Start Server ---
const server = app.listen(PORT, () => {
  console.log(`[SERVER] Server is running on http://localhost:${PORT}`);
  console.log(`[SERVER] Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`[SERVER] M-Pesa Callback endpoint: ${MPESA_CALLBACK_URL}`);
  console.log(`[SERVER] M-Pesa API Base URL: ${MPESA_API_BASE_URL}`);
});

// --- Graceful Server Shutdown ---
const shutdown = () => {
  console.log("Server is initiating graceful shutdown...");
  server.close(() => {
    console.log("HTTP server closed.");
    mongoose
      .disconnect()
      .then(() => {
        console.log("MongoDB connection closed.");
        process.exit(0);
      })
      .catch((err) => {
        console.error("Error closing MongoDB connection:", err);
        process.exit(1);
      });
  });

  setTimeout(() => {
    console.error("Forcing server shutdown due to timeout.");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
  shutdown();
});

module.exports = app;
