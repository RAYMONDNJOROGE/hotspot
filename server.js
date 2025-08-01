require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const helmet = require("helmet");
const morgan = require("morgan");
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Custom Error Class ---
class APIError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

// --- Environment Variables ---
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_BUSINESS_SHORTCODE = process.env.MPESA_BUSINESS_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;
const MPESA_API_BASE_URL =
  process.env.MPESA_API_BASE_URL || "https://sandbox.safaricom.co.ke";
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_RECIPIENT = process.env.EMAIL_RECIPIENT;
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
  .then(() => console.log("[DB] Connected to MongoDB successfully."))
  .catch((err) => {
    console.error("[DB] MongoDB initial connection error:", err.message);
    process.exit(1);
  });

// --- Payment Schema ---
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
    expiresAt: { type: Date, index: true }, // Added index for potential cleanup jobs
  },
  { timestamps: true, strict: true }
);

paymentSchema.pre("save", function (next) {
  // Ensure MpesaReceiptNumber is not an empty string
  if (this.isModified("MpesaReceiptNumber") && this.MpesaReceiptNumber === "") {
    this.MpesaReceiptNumber = undefined;
  }
  next();
});

const Payment = mongoose.model("Payment", paymentSchema);

// --- Middleware ---
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

// --- Helper Functions (extracted for better reusability) ---
/**
 * Normalizes a Kenyan phone number to the '254' format.
 * @param {string} phone The phone number to normalize.
 * @returns {string|null} The normalized phone number or null if invalid.
 */
function normalizePhoneNumber(phone) {
  phone = String(phone).trim();
  const kenyanPhoneRegex = /^(0(1|7)\d{8}|254(1|7)\d{8})$/;
  if (!kenyanPhoneRegex.test(phone)) return null;
  if (phone.startsWith("0")) return "254" + phone.substring(1);
  return phone;
}

/**
 * Calculates the expiry date for a given package description.
 * @param {string} packageDescription The description of the package.
 * @param {Date} [paidAt=new Date()] The date the payment was made.
 * @returns {Date} The calculated expiry date.
 */
function calculateExpiry(packageDescription, paidAt = new Date()) {
  let durationHours = 1; // Default to 1 hour
  const desc = packageDescription.toLowerCase();

  if (desc.includes("3-hour")) durationHours = 3;
  else if (desc.includes("7-hour")) durationHours = 7;
  else if (desc.includes("14-hour")) durationHours = 14;
  else if (desc.includes("24-hour") || desc.includes("unlimited"))
    durationHours = 24;

  return new Date(paidAt.getTime() + durationHours * 60 * 60 * 1000);
}

// --- Nodemailer transporter setup ---
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

// --- Health Check Endpoint ---
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// --- M-Pesa Payment Initiation ---
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

// --- M-Pesa Callback URL ---
app.post("/api/callback", async (req, res) => {
  // Always respond immediately to the M-Pesa server to prevent timeouts.
  res.status(200).json({ MpesaResponse: "Callback received" });

  // Use setImmediate to process the callback data asynchronously in the background.
  setImmediate(async () => {
    try {
      const callbackData = req.body;
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
      const resultDesc =
        stkCallback.ResultDesc || "No specific description provided.";

      // --- Security Check: Ensure this is a known transaction ---
      const existingPayment = await Payment.findOne({
        CheckoutRequestID: checkoutRequestID,
      });
      if (!existingPayment) {
        console.warn(
          `[Security Warning] Received callback for an unknown CheckoutRequestID: ${checkoutRequestID}. Discarding.`
        );
        return; // Ignore callbacks for transactions we didn't initiate.
      }

      // --- Avoid race conditions by not updating an already completed transaction ---
      if (existingPayment.status === "Completed") {
        console.warn(
          `[Race Condition] Received duplicate callback for CheckoutRequestID: ${checkoutRequestID}. Status is already 'Completed'.`
        );
        return;
      }

      // --- Map resultCode to a more human-readable status ---
      let status;
      switch (resultCode) {
        case 0:
          status = "Completed";
          break;
        case 1032:
          status = "Cancelled";
          break;
        case 1037: // This is "Timeout"
          status = "Timeout";
          break;
        default:
          status = "Failed";
          break;
      }

      // --- Extract and format data from the callback metadata ---
      const updateFields = {
        ResultCode: resultCode,
        ResultDesc: resultDesc,
        RawCallbackData: callbackData,
        status: status,
      };

      const callbackMetadata = stkCallback.CallbackMetadata;
      if (callbackMetadata && callbackMetadata.Item) {
        callbackMetadata.Item.forEach((item) => {
          if (item.Name === "Amount") updateFields.Amount = item.Value;
          if (item.Name === "MpesaReceiptNumber")
            updateFields.MpesaReceiptNumber = item.Value;
          if (item.Name === "TransactionDate") {
            const dateString = item.Value;
            // Parse date string (e.g., '20230802110129') into a Date object
            if (dateString && dateString.length === 14) {
              const year = dateString.substring(0, 4);
              const month = dateString.substring(4, 6) - 1; // Month is 0-indexed
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

      // --- Use the centralized helper function to calculate expiry ---
      if (status === "Completed") {
        updateFields.expiresAt = calculateExpiry(
          existingPayment.packageDescription
        );
      }

      const updatedPayment = await Payment.findByIdAndUpdate(
        existingPayment._id,
        { $set: updateFields },
        { new: true, runValidators: true }
      );

      console.log(
        `[Callback Update] Payment for CheckoutRequestID ${checkoutRequestID} updated. Status: ${updatedPayment.status}.`
      );
    } catch (error) {
      console.error(
        "CRITICAL: Error processing M-Pesa callback (async background job):",
        error
      );
    }
  });
});

// --- Check Payment Status ---
app.get(
  "/api/check_payment_status/:checkoutRequestID",
  async (req, res, next) => {
    try {
      const { checkoutRequestID } = req.params;
      if (!checkoutRequestID)
        throw new APIError("CheckoutRequestID is required.", 400);

      const payment = await Payment.findOne({
        CheckoutRequestID: checkoutRequestID,
      });

      if (!payment) {
        // Return a 202 Accepted status for a pending/unknown payment
        return res.status(202).json({
          success: true,
          status: "Processing",
          message:
            "Payment record not found or awaiting M-Pesa callback. Please try again in a moment.",
        });
      }

      let responseMessage = "Status is pending.";
      const responseStatus = payment.status;

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

// --- Endpoint to retrieve all payments (SECURE THIS!) ---
app.get("/api/payments", async (req, res, next) => {
  // A simple bearer token check. This should be replaced with a proper JWT or API key system.
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new APIError("Authentication required.", 401));
  }
  const token = authHeader.split(" ")[1];
  // --- Replace with actual token validation logic ---
  // e.g., if (token !== process.env.ADMIN_API_KEY) { ... }
  if (token !== process.env.ADMIN_API_KEY) {
    return next(new APIError("Invalid authentication token.", 403));
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

// --- Endpoint to receive comments and send an email ---
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
        <table>
        <thead>
        <th colspan="2"><strong>You have received a new comment from ${firstName} ${secondName}</strong></th>
        </thead>
        <tbody>
        <tr>
        <td>First Name:</td>
        <td>${firstName}</td>
        </tr>
        <tr>
        <td>Second Name:</td>
        <td>${secondName}</td>
        </tr>
        <tr>
        <td>Phone Number:</td>
        <td>${phone}</td>
        </tr>
        <tr>
        <td>Email:</td>
        <td>${email}</td>
        </tr>
        <tr>
        <td>Comments:</td>
        <td>${commentsText}</td>
        </tr>
        </tbody>
        </table>
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

// --- MikroTik API: Check if a phone number has a valid, unexpired payment ---
app.get("/api/mikrotik/check_payment", async (req, res, next) => {
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
    }
    const payment = await Payment.findOne({
      PhoneNumber: normalizedPhone,
      status: "Completed",
    }).sort({ createdAt: -1 });

    if (payment && payment.expiresAt && new Date() < payment.expiresAt) {
      // Use the helper to determine bandwidth based on description
      const desc = payment.packageDescription.toLowerCase();
      let bandwidth = "default";
      if (desc.includes("unlimited")) {
        bandwidth = "unlimited";
      } else if (desc.includes("3mbps") || desc.includes("vybz")) {
        bandwidth = "3mbps";
      }

      return res.json({
        success: true,
        paid: true,
        amount: payment.Amount,
        plan: payment.packageDescription,
        bandwidth,
        paidAt: payment.createdAt,
        expiresAt: payment.expiresAt,
        receipt: payment.MpesaReceiptNumber,
      });
    } else {
      // Handles both no payment found and expired payment
      return res.json({
        success: true,
        paid: false,
        message: payment
          ? "Subscription expired."
          : "No valid subscription found.",
      });
    }
  } catch (error) {
    next(error);
  }
});

// --- 404 Catch-all for unknown routes ---
app.use((req, res, next) => {
  res.status(404).json({ success: false, message: "Endpoint not found" });
});

// --- Centralized Error Handling Middleware ---
app.use((err, req, res, next) => {
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
