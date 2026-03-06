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
const allowedOrigins = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://20.2.141.38",
    "https://nf-portfolio23.vercel.app",
    "http://nf-portfolio23.vercel.app",
    "nf-portfolio23.vercel.app",
    "https://www.nittfest.in"
]);

const corsOptions = {
    origin: (origin, callback) => {
        // allow non-browser clients (curl/postman) with no origin
        if (!origin) return callback(null, true);

        if (allowedOrigins.has(origin)) {
            return callback(null, true);
        }

        return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// NOTE: In some Express/router versions, app.options("*") throws in path-to-regexp.
// Using a RegExp safely matches all routes for preflight.
app.options(/.*/, cors(corsOptions));

// Use raw body parsing strictly for razorpay webhooks so we can verify the signature
app.use("/webhooks/razorpay", express.raw({ type: "application/json" }));

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
    size1: { type: String, required: true },
    size2: { type: String },
    count: { type: Number, required: true },
    amount: { type: Number, required: true }, // in paise
    currency: { type: String, default: "INR" },
    razorpayOrderId: { type: String, required: true },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
    branch1: { type: String }, // Branch for T-Shirt 1
    branch2: { type: String }, // Branch for T-Shirt 2
    rollNumber2: { type: String }, // Roll Number for T-Shirt 2
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

// Mongoose Order Team Schema
const orderTeamSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true }, // Custom input name
    teamName: { type: String, required: true },
    position: { type: String, required: true },
    size1: { type: String, required: true },
    count: { type: Number, required: true, default: 1 },
    amount: { type: Number, required: true }, // in paise
    currency: { type: String, default: "INR" },
    razorpayOrderId: { type: String, required: true },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
    customerSnapshot: {
        rollNumber: String,
        phoneNumber: String,
    },
    orderDate: { type: Date, default: Date.now },
}, { timestamps: true });

const OrderTeam = mongoose.model("OrderTeam", orderTeamSchema);

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

app.get("/hello", (req, res) => {
    res.status(200).json("hellpo")
})
// Create Razorpay order
app.post("/payments/create-order", authMiddleware, async (req, res) => {
    try {
        const { size1, size2, count, branch1, branch2, rollNumber2 } = req.body;
        const qty = parseInt(count, 10) || 1;

        if (!size1) {
            return res.status(400).json({ error: "Size 1 is required" });
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
                size1,
                size2: size2 || "",
                count: qty,
                userId: req.user._id.toString(),
            },
        };

        const order = await razorpay.orders.create(options);

        // Pre-create the order as "created" so webhooks have a DB record to attach to.
        await Order.create({
            user: req.user._id,
            size1,
            size2: size2 || "",
            count: qty,
            branch1: branch1 || "",
            branch2: branch2 || "",
            rollNumber2: rollNumber2 || "",
            amount: amountPaise,
            currency: options.currency,
            razorpayOrderId: order.id,
            status: "created",
            customerSnapshot: {
                name: req.user.name,
                email: req.user.email,
                phoneNumber: req.user.phoneNumber,
                batch: req.user.batch,
                department: req.user.department,
                gender: req.user.gender,
            },
        });

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
        const sheetId = process.env.GOOGLE_SHEETS_ID;
        const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "google-credentials.json";

        if (!sheetId) {
            console.warn("GOOGLE_SHEETS_ID env var not set, skipping sheet append.");
            return;
        }

        const auth = new google.auth.GoogleAuth({
            keyFile: keyFilePath,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });

        // Initialize Google Sheets API
        const sheets = google.sheets({ version: "v4", auth });

        let values = [];

        const orderDateObj = order.orderDate || order.createdAt || new Date();
        const orderDateStr = new Date(orderDateObj).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        values.push([
            order.customerSnapshot?.name || "",
            order.count || 1,
            order.customerSnapshot?.email || "",
            order.customerSnapshot?.phoneNumber || "",
            order.size1 || "",
            order.branch1 || "",
            order.count >= 2 ? (order.size2 || "") : "null",
            order.count >= 2 ? (order.branch2 || "") : "null",
            order.count >= 2 ? (order.rollNumber2 || "") : "null",
            orderDateStr
        ]);

        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "Sheet1!A2:I",
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
        });
    } catch (err) {
        console.error("Failed to append order to Google Sheet:", err.message);
    }
}

// Helper to format date for Google Sheets
function formatDateToIST(date) {
    return date.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    });
}

// Helper function to append order data to Google Sheets (Team Orders - Sheet2)
async function appendTeamOrderToSheet(order) {
    try {
        const sheetId = process.env.GOOGLE_SHEETS_ID;
        const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "google-credentials.json";

        if (!sheetId) {
            console.warn("GOOGLE_SHEETS_ID env var not set, skipping team sheet append.");
            return;
        }

        const auth = new google.auth.GoogleAuth({
            keyFile: keyFilePath,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });

        // Initialize Google Sheets API
        const sheets = google.sheets({ version: "v4", auth });

        let values = [];

        const date = order.orderDate || new Date();
        const orderDateStr = formatDateToIST(date);

        values.push([
            order.name || "",
            order.customerSnapshot?.rollNumber || "",
            order.customerSnapshot?.phoneNumber || "",
            order.teamName || "",
            order.position || "",
            order.size1 || "",
            orderDateStr
        ]);

        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "Sheet2!A2:G",
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
        });

        console.log("Team Order appended to Google Sheet 2 successfully.");
    } catch (error) {
        console.error("Error appending team order to Google Sheet 2:", error);
    }
}

// Verify payment and create order (only paid orders stored)
app.post("/payments/verify", authMiddleware, async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            size1,
            size2,
            count,
            amount,
            branch1,
            branch2,
            rollNumber2,
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !size1 || !count || !amount) {
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

        let order = await Order.findOne({ razorpayOrderId: razorpay_order_id });

        if (!order) {
            return res.status(404).json({ error: "Order not found" });
        }

        if (order.status === "paid") {
            // Webhook might have already processed this
            return res.json({ success: true, order });
        }

        order.status = "paid";
        order.razorpayPaymentId = razorpay_payment_id;
        order.razorpaySignature = razorpay_signature;

        const paidOrder = await order.save();

        // fire-and-forget append to Google Sheets
        appendOrderToSheet(paidOrder).catch(() => { });

        res.json({ success: true, order: paidOrder });
    } catch (error) {
        console.error("Error verifying payment:", error);
        res.status(500).json({ error: "Payment verification failed" });
    }
});


// TEAM Create Razorpay order
app.post("/payments/team/create-order", authMiddleware, async (req, res) => {
    try {
        const { name, teamName, position, size1 } = req.body;
        const count = 1; // Fixed for teams

        if (!name || !teamName || !position || !size1) {
            return res.status(400).json({ error: "Name, Team Name, Position, and size are required" });
        }

        const amountPaise = 260 * 100; // 260 Rs for 1 shirt

        const options = {
            amount: amountPaise,
            currency: "INR",
            receipt: `rcpt_team_${Date.now()}`
        };

        razorpay.orders.create(options, async (err, order) => {
            if (err) {
                console.error("Razorpay team order creation error:", err);
                return res.status(500).json({ error: "Error creating Razorpay order", details: err });
            }

            const newTeamOrder = new OrderTeam({
                user: req.user._id,
                name: name,
                teamName: teamName,
                position: position,
                size1: size1,
                count: count,
                amount: amountPaise,
                currency: options.currency,
                razorpayOrderId: order.id,
                status: "created",
                customerSnapshot: {
                    rollNumber: req.user.batch, // 'batch' in User model holds Roll Number
                    phoneNumber: req.user.phoneNumber,
                }
            });

            await newTeamOrder.save();

            res.status(200).json({
                orderId: order.id,
                amount: options.amount,
                currency: options.currency,
                razorpayKeyId: process.env.RAZORPAY_KEY_ID
            });
        });
    } catch (error) {
        console.error("Server error creating team order:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// TEAM Verify Razorpay signature
app.post("/payments/team/verify", authMiddleware, async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: "Missing highly required payment details" });
        }

        const generated_signature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

        if (generated_signature === razorpay_signature) {
            // Update order status to paid
            const updatedTeamOrder = await OrderTeam.findOneAndUpdate(
                { razorpayOrderId: razorpay_order_id },
                {
                    razorpayPaymentId: razorpay_payment_id,
                    razorpaySignature: razorpay_signature,
                    status: "paid"
                },
                { new: true } // Return the updated document
            );

            if (updatedTeamOrder) {
                // Fire and forget appending to Google sheets (Sheet2)
                appendTeamOrderToSheet(updatedTeamOrder).catch(() => { });
            }

            res.status(200).json({ message: "Team payment verified successfully" });
        } else {
            // Update order status to failed
            await OrderTeam.findOneAndUpdate({ razorpayOrderId: razorpay_order_id }, { status: "failed" });
            res.status(400).json({ error: "Invalid signature" });
        }
    } catch (error) {
        console.error("Error in verifying team payment:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Razorpay Webhook Handler
app.post("/webhooks/razorpay", async (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const signature = req.headers["x-razorpay-signature"];

        if (!webhookSecret || !signature) {
            return res.status(400).send("Webhook secret or signature missing");
        }

        const expectedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(req.body)
            .digest("hex");

        if (expectedSignature !== signature) {
            return res.status(400).send("Invalid signature");
        }

        // req.body is a buffer here because of express.raw
        const payload = JSON.parse(req.body.toString());

        const event = payload.event;
        const paymentEntity = payload.payload?.payment?.entity;
        const orderId = paymentEntity?.order_id;
        const paymentId = paymentEntity?.id;

        if (!orderId) {
            return res.status(400).send("Missing orderId in payload");
        }

        let order = await Order.findOne({ razorpayOrderId: orderId });
        let isTeamOrder = false;

        if (!order) {
            order = await OrderTeam.findOne({ razorpayOrderId: orderId });
            if (order) {
                isTeamOrder = true;
            } else {
                console.error(`Webhook: Order ${orderId} not found in DB`);
                return res.status(404).send("Order not found");
            }
        }

        if (event === "payment.captured") {
            if (order.status !== "paid") {
                order.status = "paid";
                order.razorpayPaymentId = paymentId;
                const paidOrder = await order.save();

                if (isTeamOrder) {
                    appendTeamOrderToSheet(paidOrder).catch(() => { });
                } else {
                    appendOrderToSheet(paidOrder).catch(() => { });
                }
            }
        } else if (event === "payment.failed") {
            if (order.status !== "paid") {
                order.status = "failed";
                order.razorpayPaymentId = paymentId;
                await order.save();
            }
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("Webhook processing error:", error);
        res.status(500).send("Internal Error");
    }
});

// Get orders for logged-in user
app.get("/orders/my", authMiddleware, async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user._id, status: "paid" })
            .sort({ createdAt: -1 });
        res.json({ orders });
    } catch (error) {
        console.error("Error fetching user orders:", error);
        res.status(500).json({ error: "Failed to fetch orders" });
    }
});

// Get team orders for logged-in user
app.get("/orders/team/my", authMiddleware, async (req, res) => {
    try {
        const orders = await OrderTeam.find({ user: req.user._id, status: "paid" })
            .sort({ createdAt: -1 });
        res.json({ orders });
    } catch (error) {
        console.error("Error fetching team orders:", error);
        res.status(500).json({ error: "Failed to fetch team orders" });
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
        console.log("DAuth User Data:", userData);

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