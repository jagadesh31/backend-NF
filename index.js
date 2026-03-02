require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

// Database connection
mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/nittfest")
    .then(() => console.log("Connected to MongoDB"))
    .catch((err) => console.error("MongoDB connection error:", err));

// Mongoose User Schema
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    name: { type: String },
    gender: { type: String },
    dauthId: { type: String },
    phoneNumber: { type: String },
    batch: { type: String },
    department: { type: String },
}, { timestamps: true });

const User = mongoose.model("User", userSchema);

// Mongoose Order Schema
const orderSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    size: { type: String, required: true },
    count: { type: Number, required: true },
    amount: { type: Number, required: true }, // in paise
    currency: { type: String, default: "INR" },
    razorpayOrderId: { type: String, required: true },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
    customerSnapshot: {
        name: String,
        email: String,
        phoneNumber: String,
        batch: String,
        department: String,
        gender: String,
    },
    orderDate: { type: Date, default: Date.now },
}, { timestamps: true });

const Order = mongoose.model("Order", orderSchema);

// Razorpay instance
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});


app.get("/", (req, res) => {
    res.send("API is running...");
});

// Middleware to authenticate user via JWT from Authorization header: Bearer <token>
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Authorization token missing" });
    }

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(401).json({ error: "User not found" });
        }
        req.user = user;
        next();
    } catch (err) {
        console.error("Auth error:", err.message);
        return res.status(401).json({ error: "Invalid or expired token" });
    }
};

// Create Razorpay order
app.post("/payments/create-order", authMiddleware, async (req, res) => {
    try {
        const { size, count } = req.body;
        const qty = parseInt(count, 10) || 1;

        if (!size) {
            return res.status(400).json({ error: "Size is required" });
        }

        // Simple pricing logic: 1 for 260, 2 for 499
        let unitPrice = 260;
        if (qty === 2) {
            unitPrice = 499 / 2;
        }

        const totalAmountRupees = qty === 1 ? 260 : 499;
        const amountPaise = totalAmountRupees * 100;

        const options = {
            amount: amountPaise,
            currency: "INR",
            receipt: `nf-merch-${Date.now()}`,
            notes: {
                size,
                count: qty,
                userId: req.user._id.toString(),
            },
        };

        const order = await razorpay.orders.create(options);

        res.json({
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        });
    } catch (error) {
        console.error("Error creating Razorpay order:", error);
        res.status(500).json({ error: "Failed to create order" });
    }
});

// Helper: append order to Google Sheet
async function appendOrderToSheet(order) {
    try {
        const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        const privateKey = process.env.GOOGLE_PRIVATE_KEY;
        const sheetId = process.env.GOOGLE_SHEETS_ID;

        if (!clientEmail || !privateKey || !sheetId) {
            console.warn("Google Sheets env vars not set, skipping sheet append.");
            return;
        }

        const jwtClient = new google.auth.JWT(
            clientEmail,
            undefined,
            privateKey.replace(/\\n/g, "\n"),
            ["https://www.googleapis.com/auth/spreadsheets"]
        );

        await jwtClient.authorize();

        const sheets = google.sheets({ version: "v4", auth: jwtClient });

        const values = [[
            new Date(order.orderDate || order.createdAt || Date.now()).toISOString(),
            order._id.toString(),
            order.user.toString(),
            order.customerSnapshot?.name || "",
            order.customerSnapshot?.email || "",
            order.customerSnapshot?.phoneNumber || "",
            order.size,
            order.count,
            (order.amount / 100).toString(),
            order.currency,
            order.razorpayOrderId,
            order.razorpayPaymentId || "",
            order.status,
        ]];

        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "Sheet1!A:Z",
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
        });
    } catch (err) {
        console.error("Failed to append order to Google Sheet:", err.message);
    }
}

// Verify payment and create order (only paid orders stored)
app.post("/payments/verify", authMiddleware, async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            size,
            count,
            amount,
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !size || !count || !amount) {
            return res.status(400).json({ error: "Missing payment details" });
        }

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest("hex");

        const isValid = expectedSignature === razorpay_signature;

        if (!isValid) {
            return res.status(400).json({ error: "Invalid payment signature" });
        }

        const qty = parseInt(count, 10) || 1;

        const paidOrder = await Order.create({
            user: req.user._id,
            size,
            count: qty,
            amount,
            currency: "INR",
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            razorpaySignature: razorpay_signature,
            status: "paid",
            customerSnapshot: {
                name: req.user.name,
                email: req.user.email,
                phoneNumber: req.user.phoneNumber,
                batch: req.user.batch,
                department: req.user.department,
                gender: req.user.gender,
            },
            orderDate: new Date(),
        });

        // fire-and-forget append to Google Sheets
        appendOrderToSheet(paidOrder).catch(() => {});

        res.json({ success: true, order: paidOrder });
    } catch (error) {
        console.error("Error verifying payment:", error);
        res.status(500).json({ error: "Payment verification failed" });
    }
});

// Get orders for logged-in user
app.get("/orders/my", authMiddleware, async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user._id })
            .sort({ createdAt: -1 });
        res.json({ orders });
    } catch (error) {
        console.error("Error fetching user orders:", error);
        res.status(500).json({ error: "Failed to fetch orders" });
    }
});

// DAuth Callback Route
app.post("/auth/dauth/callback", async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: "Authorization code missing" });
        }

        // 1. Exchange 'code' for 'access_token'
        const tokenResponse = await axios.post("https://auth.delta.nitt.edu/api/oauth/token", new URLSearchParams({
            client_id: process.env.DAUTH_CLIENT_ID,
            client_secret: process.env.DAUTH_CLIENT_SECRET,
            grant_type: "authorization_code",
            code: code,
            redirect_uri: process.env.DAUTH_REDIRECT_URI,
        }), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });

        const accessToken = tokenResponse.data.access_token;
        if (!accessToken) {
            return res.status(500).json({ error: "Failed to obtain access token" });
        }

        // 2. Fetch User Profile
        const userResponse = await axios.post("https://auth.delta.nitt.edu/api/resources/user", {}, {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        const userData = userResponse.data;

        // NITT DAuth returns properties like gender, name, email, phoneNumber, batch, id, etc.
        const { email, name, gender, id, phoneNumber, batch, department } = userData;

        if (!email) {
            return res.status(400).json({ error: "Email not provided by DAuth" });
        }

        // 3. Find or Create User in DB
        let user = await User.findOne({ email });
        if (!user) {
            user = new User({
                email,
                name,
                gender,
                dauthId: id,
                phoneNumber,
                batch,
                department,
            });
            await user.save();
        } else {
            // Update any changed info if needed
            user.name = name || user.name;
            user.gender = gender || user.gender;
            user.dauthId = id || user.dauthId;
            user.phoneNumber = phoneNumber || user.phoneNumber;
            user.batch = batch || user.batch;
            user.department = department || user.department;
            await user.save();
        }

        // 4. Generate JWT for our app
        const appToken = jwt.sign(
            { userId: user._id, email: user.email },
            process.env.JWT_SECRET || "secret",
            { expiresIn: "7d" }
        );

        // 5. Send token and the WHOLE user info object
        res.json({ token: appToken, user: user });

    } catch (error) {
        console.error("DAuth callback error:", error?.response?.data || error.message);
        res.status(500).json({ error: "Internal Server Error during DAuth login" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});