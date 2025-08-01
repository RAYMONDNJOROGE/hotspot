// 1. Load Environment Variables - Always at the very top
require("dotenv").config();

// 2. Import Required Modules
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const helmet = require("helmet"); // Security headers for Express
const morgan = require("morgan"); // Request logging middleware
const fetch = require("node-fetch"); // For making server-side HTTP requests
const nodemailer = require("nodemailer"); // Library for sending emails

const app = express();
const PORT = process.env.PORT || 3000;

// --- Custom Error Class and Centralized Handler ---
// This provides a consistent way to handle API errors with custom messages and status codes.
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

// --- MongoDB Connection String (from .env) ---
const MONGODB_URI = process.env.MONGODB_URI;

// --- Critical Environment Variable Check ---
// This log is crucial to know what's missing on server startup. Do not remove.
const requiredEnvVars = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_BUSINESS_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL",
  "MONGODB_URI",
  "EMAIL_USER",
  "EMAIL_PASS",
  "EMAIL_RECIPIENT",
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
  .then(() => {
    console.log("[DB] Connected to MongoDB successfully.");
  })
  .catch((err) => {
    // This log is critical for checking if the database connection failed.
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
    packageDescription: { type: String },
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
  },
  {
    timestamps: true,
    strict: true,
  }
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
  if (!kenyanPhoneRegex.test(phone)) {
    return null;
  }
  if (phone.startsWith("0")) {
    return "254" + phone.substring(1);
  }
  return phone;
}

// --- Nodemailer transporter setup ---
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// --- API Routes ---

// M-Pesa Payment Initiation API Endpoint
app.post("/api/process_payment", async (req, res, next) => {
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
      {
        method: "GET",
        headers: { Authorization: `Basic ${auth}` },
      }
    );

    if (!tokenResponse.ok) {
      const tokenError = await tokenResponse
        .json()
        .catch(() => ({ message: "Failed to parse M-Pesa token error" }));
      // Refined log: Do not log the full tokenError object to prevent data leaks.
      console.error(
        "Failed to get M-Pesa access token. Status:",
        tokenResponse.status,
        "Error message:",
        tokenError.errorMessage || tokenError.message
      );
      throw new APIError(
        "Failed to authenticate with M-Pesa. Please try again later.",
        tokenResponse.status,
        process.env.NODE_ENV !== "production" ? tokenError : undefined
      );
    }
    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      // Refined log: Do not log the full tokenData object.
      console.error(
        "M-Pesa authentication failed unexpectedly: No access token received."
      );
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
      const errorMessage =
        stkPushData.CustomerMessage ||
        stkPushData.ResponseDescription ||
        stkPushData.errorMessage ||
        "Unknown error from M-Pesa during STK push initiation.";

      const failedPayment = new Payment({
        MerchantRequestID:
          stkPushData.MerchantRequestID || `Failed-${Date.now()}`,
        CheckoutRequestID:
          stkPushData.CheckoutRequestID || `Failed-${Date.now()}`,
        status: "Failed",
        Amount: amount,
        PhoneNumber: phone,
        ResultCode: stkPushData.ResponseCode,
        ResultDesc: errorMessage,
        RawCallbackData: stkPushData,
        packageDescription: packageDescription,
      });
      await failedPayment
        .save()
        .catch((dbErr) =>
          console.error("Failed to save failed payment attempt:", dbErr)
        );

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

// M-Pesa Callback URL
app.post("/api/mpesa_callback", async (req, res) => {
  const callbackData = req.body;
  // Always return a 200 OK status immediately to M-Pesa.
  res.status(200).json({ MpesaResponse: "Callback received" });

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

      const updateFields = {
        ResultCode: resultCode,
        ResultDesc:
          stkCallback.ResultDesc || "No specific description provided.",
        RawCallbackData: callbackData,
      };

      if (resultCode === 0) {
        updateFields.status = "Completed";
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
        }
      } else {
        updateFields.status = resultCode === 1032 ? "Cancelled" : "Failed";
      }

      const query = {
        $or: [
          { CheckoutRequestID: checkoutRequestID },
          { MerchantRequestID: merchantRequestID },
        ],
      };

      const updatedPayment = await Payment.findOneAndUpdate(
        query,
        { $set: updateFields },
        { new: true, upsert: true, runValidators: true }
      );

      if (updatedPayment) {
        console.log(
          `Payment record updated/created for CheckoutRequestID ${checkoutRequestID}. Status: ${updatedPayment.status}`
        );
        if (updatedPayment.status === "Completed") {
          console.log(
            `[Service Fulfillment] Payment for ${updatedPayment.MpesaReceiptNumber} completed. Fulfilling service for ${updatedPayment.PhoneNumber}.`
          );
        }
      } else {
        // This is a crucial warning log to detect missing payment records.
        console.warn(
          `[DB Issue] findOneAndUpdate did not return a document for CheckoutRequestID ${checkoutRequestID}.`
        );
      }
    } catch (error) {
      // This is a critical error log for tracking callback failures.
      console.error(
        "CRITICAL: Error processing M-Pesa callback (async background job):",
        error
      );
    }
  });
});

// NEW: Endpoint for frontend to check the status of a specific payment
app.get(
  "/api/check_payment_status/:checkoutRequestID",
  async (req, res, next) => {
    try {
      const { checkoutRequestID } = req.params;

      if (!checkoutRequestID) {
        throw new APIError("CheckoutRequestID is required.", 400);
      }

      const payment = await Payment.findOne({
        CheckoutRequestID: checkoutRequestID,
      });

      if (!payment) {
        // If the record isn't found yet, assume it's still being processed
        return res.status(200).json({
          success: true,
          status: "Processing",
          message: "Payment record not found. Awaiting callback.",
        });
      }

      const responseStatus = payment.status;
      let responseMessage = "Status is pending.";

      // Custom messages based on final status
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

// Endpoint to retrieve all payments (SECURE THIS!)
app.get("/api/payments", async (req, res, next) => {
  // This check is a great security practice. It ensures this endpoint is protected in production.
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
// This is your most important security measure against leaking server details.
app.use((err, req, res, next) => {
  const logLevel = err.statusCode && err.statusCode < 500 ? "warn" : "error";
  if (process.env.NODE_ENV !== "production") {
    console[logLevel]("Unhandled Server Error (DEV):", err.stack || err);
  } else {
    // In production, log a minimal message and no stack trace.
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
// These logs are critical for catching unexpected errors that can crash the server.
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
  shutdown();
});

module.exports = app;
