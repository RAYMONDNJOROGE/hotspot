# Raynger-Hotspot: M-Pesa-Powered MikroTik Hotspot Backend

This project is a Node.js backend for managing M-Pesa-powered payments for MikroTik WiFi hotspots. It enables users to pay for internet access using M-Pesa, and automatically grants or revokes access based on payment status and plan expiry.

---

## Features

- **M-Pesa STK Push Integration**: Users pay via M-Pesa and receive instant payment prompts.
- **MongoDB Storage**: All payment records are securely stored in MongoDB.
- **MikroTik API Endpoint**: MikroTik routers can verify payment and plan status before granting access.
- **Bandwidth & Expiry Control**: Supports different plans (e.g., 3-Hour, 7-Hour, Unlimited) and enforces expiry and bandwidth limits.
- **Admin & User Endpoints**: Includes endpoints for payment status checks and admin payment retrieval.
- **Secure & Modern**: Uses best practices for security, error handling, and environment management.

---

## Prerequisites

- Node.js (v18+ recommended)
- MongoDB database (local or cloud)
- MikroTik router with Hotspot enabled
- M-Pesa Daraja API credentials

---

## Setup

1. **Clone the repository**

   ```sh
   git clone https://github.com/RAYMONDNJOROGE/hotspot.git
   cd node-back-pay
   ```

2. **Install dependencies**

   ```sh
   npm install
   ```

3. **Configure environment variables**

   Create a `.env` file in the root directory with the following (replace with your actual values):

   ```
   MPESA_CONSUMER_KEY=your_consumer_key
   MPESA_CONSUMER_SECRET=your_consumer_secret
   MPESA_BUSINESS_SHORTCODE=your_shortcode
   MPESA_PASSKEY=your_passkey
   MPESA_CALLBACK_URL=https://yourdomain.com/api/callback
   MPESA_API_BASE_URL=https://sandbox.safaricom.co.ke
   MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/dbname
   EMAIL_USER=your_email@gmail.com
   EMAIL_PASS=your_email_password
   EMAIL_RECIPIENT=admin@yourdomain.com
   NODE_ENV=development
   ```

4. **Start the server**
   ```sh
   npm run dev
   ```
   or for production:
   ```sh
   npm start
   ```

---

## MikroTik Integration

- MikroTik should call the backend API to check payment status:
  ```
  GET /api/mikrotik/check_payment?phone=07XXXXXXXX
  ```
- The API will respond with payment, expiry, and bandwidth info.
- Use MikroTik scripts or RADIUS to automate access control based on API responses.

---

## API Endpoints

- `POST /api/process_payment` — Initiate M-Pesa payment
- `POST /api/mpesa_callback` — M-Pesa callback handler
- `GET /api/check_payment_status/:checkoutRequestID` — Check payment status
- `GET /api/mikrotik/check_payment?phone=07XXXXXXXX` — MikroTik payment check
- `GET /api/payments` — List all payments (secure this endpoint)
- `POST /api/submit_comment` — Submit user comments/feedback

---

## Security

- Never commit your `.env` file or sensitive credentials.
- Use HTTPS in production.
- Secure admin endpoints with authentication.

---

## License

ISC

---

## Author

[Raymond Njoroge](https://github.com/RAYMONDNJOROGE)

---

## Contributing

Pull requests and issues are welcome!
