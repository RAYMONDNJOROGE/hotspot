// 1. Load Environment Variables - Always at the very top
require("dotenv").config();

// 2. Import Required Modules
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const helmet = require("helmet"); // Security headers
const morgan = require("morgan"); // Request logging
const fetch = require("node-fetch"); // For server-side HTTP requests
const nodemailer = require("nodemailer"); // <--- NEW: Email sending library

const app = express();
const PORT = process.env.PORT || 3000;

// --- Custom Error Class and Handler (can be moved to utils/errorHandler.js) ---
class APIError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.details = details; // Useful for passing specific error details in dev
    Error.captureStackTrace(this, this.constructor); // Captures stack trace
  }
}

// --- M-Pesa API Configuration from Environment Variables ---
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_BUSINESS_SHORTCODE = process.env.MPESA_BUSINESS_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;
const MPESA_API_BASE_URL =
  process.env.MPESA_API_BASE_URL || "https://sandbox.safaricom.co.ke"; // Default to sandbox

// --- Email Service Configuration from Environment Variables ---
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_RECIPIENT = process.env.EMAIL_RECIPIENT;

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
  "EMAIL_USER", // <--- NEW: Added for email functionality
  "EMAIL_PASS", // <--- NEW: Added for email functionality
  "EMAIL_RECIPIENT", // <--- NEW: Added for email functionality
];

const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnvVars.length > 0) {
  console.error(
    `CRITICAL ERROR: The following required environment variables are missing: ${missingEnvVars.join(
      ", "
    )}`
  );
  process.exit(1); // Exit with a non-zero code to indicate failure
}

// --- Connect to MongoDB ---
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("[DB] Connected to MongoDB successfully.");
  })
  .catch((err) => {
    console.error("[DB] MongoDB initial connection error:", err.message);
    process.exit(1); // Exit if initial connection fails
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
      sparse: true, // Allows null/undefined values to not violate unique constraint
      index: true,
    },
    TransactionDate: { type: Date }, // Correctly defined as Date type
    PhoneNumber: { type: String },
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
      ], // Added 'Timeout' for STK push that expires
    },
    RawCallbackData: { type: mongoose.Schema.Types.Mixed }, // Store the full callback for debugging/auditing
  },
  {
    timestamps: true, // Automatically adds createdAt and updatedAt
    strict: true, // Ensures only schema-defined fields are saved
  }
);

// Pre-save hook: Handle empty string for MpesaReceiptNumber
paymentSchema.pre("save", function (next) {
  if (this.MpesaReceiptNumber === "") {
    this.MpesaReceiptNumber = undefined; // Set to undefined to allow sparse unique index to work
  }
  next();
});

const Payment = mongoose.model("Payment", paymentSchema);

// --- Middleware Configuration ---

// Security Headers
app.use(helmet());

// CORS Configuration - Restrict origins in production
// IMPORTANT: Replace with your actual production frontend URL(s)
const allowedOrigins =
  process.env.NODE_ENV === "production" // Corrected: "production" should be a string
    ? ["https://hotspot-gved.onrender.com"] // Corrected: Removed the trailing slash
    : ["http://localhost:3000", "http://localhost:5500"]; // Common local dev servers, including live server

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}.`;
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  })
);

// Request Logging
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Body parsing middleware
// Use Express's built-in JSON and URL-encoded parsers for modern Express
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Static Files - Ensure this points to where your index.html is
app.use(express.static(path.join(__dirname, "public"))); // Assuming public directory holds index.html

// --- Helper for Phone Number Normalization and Validation ---
function normalizePhoneNumber(phone) {
  phone = String(phone).trim(); // Ensure it's a string and trim whitespace
  if (!phone || phone.length < 9 || phone.length > 12) {
    // Add max length check
    return null;
  }

  // Remove leading '+' if present
  if (phone.startsWith("+")) {
    phone = phone.substring(1);
  }

  // Convert 07... to 2547...
  if (phone.startsWith("07")) {
    phone = "254" + phone.substring(1);
  }
  // Handle cases like "7XXXXXXXX" assuming 254 prefix
  else if (phone.length === 8 && phone.startsWith("01")) {
    phone = "254" + phone.substring(1);
  }

  // Strict validation for Kenyan Safaricom mobile numbers (starting with 2547)
  const kenyanSafaricomRegex = /^2547[0-9]{8}$/; // Exactly 2547 followed by 8 digits
  if (kenyanSafaricomRegex.test(phone)) {
    return phone;
  }
  return null; // Invalid format
}

// <--- NEW: Nodemailer transporter setup (placed with other configurations) --->
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

    // --- Input Validation ---
    if (!amount || !phone || !packageDescription) {
      throw new APIError(
        "Missing required payment details: amount, phone, or package description.",
        400
      );
    }

    // Ensure amount is a number and positive
    amount = parseFloat(amount);
    if (isNaN(amount) || amount <= 0) {
      throw new APIError(
        "Invalid amount provided. Amount must be a positive number.",
        400
      );
    }

    // Normalize and validate phone number
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      throw new APIError(
        "Invalid phone number format. Please use a valid Kenyan Safaricom mobile number (e.g., 07XXXXXXXX or 01XXXXXXXX).",
        400
      );
    }
    phone = normalizedPhone; // Use the normalized phone number

    // Generate M-Pesa timestamp
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    // 1. Get OAuth Token
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
      console.error(
        "Failed to get M-Pesa access token:",
        tokenResponse.status,
        tokenError
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
      console.error("M-Pesa access token not found in response:", tokenData);
      throw new APIError(
        "M-Pesa authentication failed unexpectedly: No access token received.",
        500
      );
    }

    // 2. Initiate Lipa Na M-Pesa Online STK Push
    const password = Buffer.from(
      `${MPESA_BUSINESS_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString("base64");

    const stkPushPayload = {
      BusinessShortCode: MPESA_BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount, // Ensure this is a number
      PartyA: phone, // Normalized phone
      PartyB: MPESA_BUSINESS_SHORTCODE,
      PhoneNumber: phone, // Normalized phone
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: packageDescription, // Use packageDescription as account reference
      TransactionDesc: `Payment for ${packageDescription} via Raynger Hotspot Services`,
    };

    console.log("STK Push Payload:", JSON.stringify(stkPushPayload, null, 2));

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
    console.log("M-Pesa STK Push Response:", stkPushData);

    if (stkPushData.ResponseCode === "0") {
      // Save initial payment request with a "Processing" status
      const newPayment = new Payment({
        MerchantRequestID: stkPushData.MerchantRequestID,
        CheckoutRequestID: stkPushData.CheckoutRequestID,
        status: "Processing", // Indicates request sent, awaiting M-Pesa callback
        Amount: amount,
        PhoneNumber: phone,
      });
      await newPayment.save();
      console.log("Initial payment request saved to MongoDB:", newPayment._id);

      res.status(200).json({
        success: true,
        message:
          "Payment request sent successfully. Please complete the transaction on your phone.",
        customerMessage:
          stkPushData.CustomerMessage || "Awaiting user payment confirmation.", // Prioritize M-Pesa's message
        checkoutRequestID: stkPushData.CheckoutRequestID,
      });
    } else {
      // M-Pesa API returned an error or rejected the request
      const errorMessage =
        stkPushData.CustomerMessage ||
        stkPushData.ResponseDescription ||
        stkPushData.errorMessage ||
        "Unknown error from M-Pesa during STK push initiation.";

      console.error("STK Push failed:", errorMessage, stkPushData);

      // Optionally save a record of the failed attempt
      const failedPayment = new Payment({
        MerchantRequestID:
          stkPushData.MerchantRequestID || `Failed-${Date.now()}`, // Ensure a unique ID even on M-Pesa failure
        CheckoutRequestID:
          stkPushData.CheckoutRequestID || `Failed-${Date.now()}`,
        status: "Failed",
        Amount: amount,
        PhoneNumber: phone,
        ResultCode: stkPushData.ResponseCode,
        ResultDesc: errorMessage,
        RawCallbackData: stkPushData, // Store the M-Pesa error response
      });
      await failedPayment
        .save()
        .catch((dbErr) =>
          console.error("Failed to save failed payment attempt:", dbErr)
        );

      throw new APIError(
        `Payment initiation failed: ${errorMessage}`,
        400, // Use 400 for client-side errors returned by M-Pesa
        process.env.NODE_ENV !== "production" ? stkPushData : undefined
      );
    }
  } catch (error) {
    next(error); // Pass error to centralized error handler
  }
});

// M-Pesa Callback URL (Confirmation and Validation URLs go here)
app.post("/api/mpesa_callback", async (req, res) => {
  const callbackData = req.body;
  console.log(
    "M-Pesa Callback received:",
    JSON.stringify(callbackData, null, 2)
  );

  // M-Pesa expects a 200 OK response quickly. Send it immediately.
  res.status(200).json({ MpesaResponse: "Callback received" });

  // Process callback data in the background to avoid blocking M-Pesa's retries
  setImmediate(async () => {
    try {
      if (!callbackData.Body || !callbackData.Body.stkCallback) {
        console.error(
          "Invalid M-Pesa callback format: Missing Body or stkCallback."
        );
        // Log the invalid callback for investigation
        // Optionally save to a "bad callbacks" collection in DB
        return;
      }

      const stkCallback = callbackData.Body.stkCallback;
      const merchantRequestID = stkCallback.MerchantRequestID;
      const checkoutRequestID = stkCallback.CheckoutRequestID;
      const resultCode = stkCallback.ResultCode;
      const resultDesc =
        stkCallback.ResultDesc || // Prioritize ResultDesc directly from stkCallback
        (stkCallback.CallbackMetadata &&
          stkCallback.CallbackMetadata.Item &&
          stkCallback.CallbackMetadata.Item.find(
            (item) => item.Name === "ResultDesc"
          )?.Value) ||
        "No specific description provided."; // Fallback to a default message

      // Prepare update object for existing payment record
      const updateFields = {
        ResultCode: resultCode,
        ResultDesc: resultDesc,
        RawCallbackData: callbackData,
      };

      if (resultCode === 0) {
        // Successful transaction
        updateFields.status = "Completed";
        const callbackMetadata = stkCallback.CallbackMetadata;
        if (callbackMetadata && callbackMetadata.Item) {
          callbackMetadata.Item.forEach((item) => {
            if (item.Name === "Amount") updateFields.Amount = item.Value;
            if (item.Name === "MpesaReceiptNumber")
              updateFields.MpesaReceiptNumber = item.Value;
            if (item.Name === "TransactionDate") {
              // Convert M-Pesa's date string (YYYYMMDDHHmmss) to Date object
              const dateString = item.Value;
              if (dateString && dateString.length === 14) {
                // M-Pesa timestamp is usually EAT (+3), create Date in UTC for consistency
                const year = dateString.substring(0, 4);
                const month = dateString.substring(4, 6) - 1; // Month (0-indexed)
                const day = dateString.substring(6, 8);
                const hour = dateString.substring(8, 10);
                const minute = dateString.substring(10, 12);
                const second = dateString.substring(12, 14);

                // Construct as local date then convert to UTC if M-Pesa sends local time
                // OR simply parse into ISO if it's consistently formatted.
                // For robust handling, libraries like moment-timezone or date-fns-tz are best.
                // Simple approach assuming it's a date-time string without timezone, best interpreted as UTC if possible.
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
        // Failed or Cancelled transaction
        updateFields.status = resultCode === 1032 ? "Cancelled" : "Failed";
      }

      // Find and Update or Create the payment record using $set
      // Use $or to find by either CheckoutRequestID or MerchantRequestID
      const query = {
        $or: [
          { CheckoutRequestID: checkoutRequestID },
          { MerchantRequestID: merchantRequestID },
        ],
      };

      const updatedPayment = await Payment.findOneAndUpdate(
        query,
        { $set: updateFields },
        { new: true, upsert: true, runValidators: true } // upsert: true creates if not found, new: true returns updated doc
      );

      if (updatedPayment) {
        console.log(
          `Payment record updated/created for CheckoutRequestID ${checkoutRequestID}. Status: ${updatedPayment.status}`
        );
        // Implement logic here for successful payment (e.g., fulfill service, send confirmation email)
        if (updatedPayment.status === "Completed") {
          console.log(
            `[Service Fulfillment] Payment for ${updatedPayment.MpesaReceiptNumber} completed. Fulfilling service for ${updatedPayment.PhoneNumber}.`
          );
          // YOUR SERVICE FULFILLMENT LOGIC GOES HERE (e.g., update user balance, grant access)
          // This is where you would typically call an internal service to activate hotspot access.
          // For example:
          // await activateHotspotService(updatedPayment.PhoneNumber, updatedPayment.Amount);
        }
      } else {
        console.warn(
          `[DB Issue] findOneAndUpdate did not return a document for CheckoutRequestID ${checkoutRequestID}.`
        );
        // This scenario should be rare with upsert:true but can happen if query is too broad/wrong
      }
    } catch (error) {
      console.error(
        "CRITICAL: Error processing M-Pesa callback (async background job):",
        error
      );
      // Implement external logging/alerting here (e.g., Sentry, New Relic) for critical issues
    }
  });
});

// Endpoint to retrieve all payments (for testing/admin purposes - SECURE THIS!)
app.get("/api/payments", async (req, res, next) => {
  // IMPORTANT: Implement strong authentication and authorization for this endpoint in production.
  // Example: JWT authentication, API key validation, role-based access control.
  // For local development, you might relax this for ease of testing, but tighten it immediately for deployment.
  if (
    process.env.NODE_ENV === "production" &&
    (!req.headers.authorization ||
      !req.headers.authorization.startsWith("Bearer "))
  ) {
    return next(new APIError("Authentication required.", 401));
  }
  // Simple API key validation for illustration (NOT recommended for production without HTTPS and proper token management)
  // const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
  // if (process.env.NODE_ENV === "production" && token !== process.env.ADMIN_API_KEY) {
  //     return next(new APIError("Unauthorized access.", 403));
  // }

  try {
    // Add pagination, filtering, and sorting options for large datasets
    const {
      page = 1,
      limit = 10,
      status,
      sort = "createdAt",
      order = -1, // -1 for desc (newest first), 1 for asc
    } = req.query;
    const query = status ? { status } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOrder = parseInt(order); // -1 for desc, 1 for asc

    const payments = await Payment.find(query)
      .sort({ [sort]: sortOrder }) // Dynamic sorting
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
    next(error); // Pass to error handling middleware
  }
});

// <--- NEW: Endpoint to receive comments and send an email --->
app.post("/api/submit_comment", async (req, res, next) => {
  try {
    const { firstName, secondName, phone, email, commentsText } = req.body;

    // --- Input Validation & Sanitization ---
    // In a production app, you'd add more thorough validation here
    if (!commentsText) {
      return next(new APIError("Comment text is required.", 400));
    }

    const mailOptions = {
      from: EMAIL_USER,
      to: EMAIL_RECIPIENT,
      subject: `New Comment from ${firstName || "Anonymous"} ${
        secondName || ""
      }`,
      // Use a simple HTML template for the email body
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

    // Save the comment to a database if needed
    // ... your logic here ...

    res
      .status(200)
      .json({ success: true, message: "Comment submitted successfully!" });
  } catch (error) {
    console.error("Error sending email:", error);
    // Use the custom error handler for consistency
    next(
      new APIError(
        "Failed to send comment. Please try again later.",
        500,
        error
      )
    );
  }
});

// Basic comments endpoint (for demonstration in frontend)
app.post("/api/comments", (req, res, next) => {
  try {
    const { firstName, secondName, phone, email, commentsText } = req.body;
    // In a real application, you would:
    // 1. Validate inputs more thoroughly
    // 2. Sanitize inputs to prevent XSS attacks
    // 3. Save to a database (e.g., a Comments collection)
    console.log("Received new comment:", {
      firstName,
      secondName,
      phone,
      email,
      commentsText,
    });
    // For now, just send a success response
    res
      .status(200)
      .json({ success: true, message: "Comment received successfully!" });
  } catch (error) {
    next(new APIError("Failed to process comment.", 500, error));
  }
});

// --- Centralized Error Handling Middleware ---
// This must be the LAST middleware added to your express app.
app.use((err, req, res, next) => {
  // Determine the log level (e.g., warn for 4xx, error for 5xx)
  const logLevel = err.statusCode && err.statusCode < 500 ? "warn" : "error";

  // Log the error details based on environment
  if (process.env.NODE_ENV !== "production") {
    console[logLevel]("Unhandled Server Error (DEV):", err.stack || err);
  } else {
    // In production, log less sensitive details or use a dedicated error tracking service
    // Example: Sentry.captureException(err, { req, user: req.user });
    console[logLevel]("Unhandled Server Error (PROD):", err.message, {
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
  }

  // Determine the status code and message
  let statusCode = 500;
  let message = "An internal server error occurred. Please try again later.";
  let errorDetails = undefined; // Only exposed in dev

  if (err instanceof APIError) {
    statusCode = err.statusCode;
    message = err.message;
    if (process.env.NODE_ENV !== "production") {
      errorDetails = err.details; // Expose details only in dev
    }
  } else if (err.name === "ValidationError" && err.errors) {
    // Mongoose validation error
    statusCode = 400;
    message = "Data validation failed.";
    errorDetails = Object.values(err.errors).map((val) => val.message);
  } else if (err.name === "CastError" && err.path) {
    // Mongoose cast error
    statusCode = 400;
    message = `Invalid format for ${err.path}.`;
  }

  // Send the error response
  res.status(statusCode).json({
    success: false,
    message: message, // Primary message for the frontend
    error: errorDetails, // Detailed error for debugging (dev only)
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
        process.exit(0); // Exit cleanly
      })
      .catch((err) => {
        console.error("Error closing MongoDB connection:", err);
        process.exit(1); // Exit with error
      });
  });

  // Force close if server doesn't close after a timeout
  setTimeout(() => {
    console.error("Forcing server shutdown due to timeout.");
    process.exit(1);
  }, 10000); // 10 seconds timeout
};

process.on("SIGTERM", shutdown); // Sent by process managers (e.g., Render, Docker)
process.on("SIGINT", shutdown); // Sent by Ctrl+C

// Catch unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason.message || reason);
  // In production, consider exiting after logging to prevent unforeseen issues.
  // For now, just log.
});

// Catch uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
  // This is a critical error; the process is in an undefined state.
  // Log the error and gracefully shut down.
  shutdown();
});

// Export the app for testing purposes
module.exports = app;
