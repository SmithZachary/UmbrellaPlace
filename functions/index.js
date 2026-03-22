// Umbrella Place Cloud Functions — v2
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, cert } = require("firebase-admin/app");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const { defineString } = require("firebase-functions/params");
const Anthropic = require("@anthropic-ai/sdk");

initializeApp();

const gmailUser = defineString("GMAIL_USER");
const gmailPass = defineString("GMAIL_APP_PASSWORD");
const sheetId = defineString("GOOGLE_SHEET_ID");

// --- Lead Scoring Algorithm ---
function scoreLead(data) {
  let score = 0;

  // Timeline urgency (0-3 pts)
  const timelineScores = { asap: 3, "30-days": 2, "60-days": 1, exploring: 0 };
  score += timelineScores[data.timeline] || 0;

  // Loan amount (0-3 pts)
  const amountScores = {
    "5m-plus": 3, "3m-5m": 2.5, "1m-3m": 2,
    "500k-1m": 1.5, "250k-500k": 1, "under-250k": 0.5,
  };
  score += amountScores[data.loanAmount] || 0;

  // Credit score (0-2 pts)
  const credit = data.creditScore || "";
  if (credit.includes("740") || credit.includes("760") || credit.includes("780") || credit.includes("800") || credit === "excellent" || credit === "740+") {
    score += 2;
  } else if (credit.includes("700") || credit.includes("720") || credit === "good") {
    score += 1.5;
  } else if (credit.includes("660") || credit.includes("680") || credit === "fair") {
    score += 1;
  } else if (credit) {
    score += 0.5;
  }

  // Contact completeness (0-2 pts)
  if (data.email) score += 0.5;
  if (data.phone) score += 0.5;
  if (data.propertyState) score += 0.5;
  if (data.loanType) score += 0.5;

  return Math.min(Math.round(score * 10) / 10, 10);
}

exports.onNewInquiry = onDocumentCreated(
  {
    document: "inquiries/{docId}",
  },
  async (event) => {
    const data = event.data.data();

    const loanTypeLabels = {
      bridge: "Bridge Loan",
      "fix-flip": "Fix & Flip",
      construction: "New Construction",
      dscr: "DSCR Rental Loan",
      other: "Other",
    };

    const timelineLabels = {
      asap: "ASAP (under 2 weeks)",
      "30-days": "Within 30 days",
      "60-days": "Within 60 days",
      exploring: "Just exploring options",
    };

    const loanAmountLabels = {
      "under-250k": "Under $250K",
      "250k-500k": "$250K – $500K",
      "500k-1m": "$500K – $1M",
      "1m-3m": "$1M – $3M",
      "3m-5m": "$3M – $5M",
      "5m-plus": "$5M+",
    };

    const name = [data.firstName, data.lastName].filter(Boolean).join(" ");
    const loanType = loanTypeLabels[data.loanType] || data.loanType || "—";
    const loanAmount = loanAmountLabels[data.loanAmount] || data.loanAmount || "—";
    const timeline = timelineLabels[data.timeline] || data.timeline || "—";
    const submittedDate = data.submittedAt
      ? new Date(data.submittedAt).toLocaleString("en-US", { timeZone: "America/New_York" })
      : new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

    // --- Send email ---
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser.value(),
        pass: gmailPass.value(),
      },
    });

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a3c6e; color: #fff; padding: 20px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0; font-size: 20px;">New Loan Inquiry</h2>
          <p style="margin: 4px 0 0; opacity: 0.8; font-size: 14px;">Umbrella Place - Lead Notification</p>
        </div>
        <div style="border: 1px solid #e2e6ed; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <h3 style="color: #1a3c6e; margin: 0 0 16px; font-size: 16px;">Contact Information</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr><td style="padding: 6px 0; color: #5a6478; width: 140px;">Name</td><td style="padding: 6px 0; font-weight: 600;">${escHtml(name)}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Email</td><td style="padding: 6px 0;">${escHtml(data.email) || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Phone</td><td style="padding: 6px 0;">${escHtml(data.phone) || "—"}</td></tr>
          </table>
          <hr style="border: none; border-top: 1px solid #e2e6ed; margin: 16px 0;">
          <h3 style="color: #1a3c6e; margin: 0 0 16px; font-size: 16px;">Deal Details</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr><td style="padding: 6px 0; color: #5a6478; width: 140px;">Loan Type</td><td style="padding: 6px 0;">${escHtml(loanType)}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Property Type</td><td style="padding: 6px 0;">${escHtml(data.propertyType) || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Loan Purpose</td><td style="padding: 6px 0;">${escHtml(data.loanPurpose) || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Loan Amount</td><td style="padding: 6px 0;">${escHtml(loanAmount)}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Property State</td><td style="padding: 6px 0;">${escHtml(data.propertyState) || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Credit Score</td><td style="padding: 6px 0;">${escHtml(data.creditScore) || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Timeline</td><td style="padding: 6px 0;">${escHtml(timeline)}</td></tr>
          </table>
          <hr style="border: none; border-top: 1px solid #e2e6ed; margin: 16px 0;">
          <p style="font-size: 12px; color: #8a94a6; margin: 0;">
            Submitted on ${submittedDate} ET
          </p>
        </div>
      </div>
    `;

    const mailOptions = {
      from: `"Umbrella Place" <${gmailUser.value()}>`,
      to: "zachary@umbrellaplace.com, csmith@umbrellaplace.com",
      subject: `New Inquiry: ${name} — ${loanType}`,
      html: htmlBody,
    };

    await transporter.sendMail(mailOptions);
    console.log("Notification email sent for inquiry:", event.params.docId);

    // --- Lead Scoring ---
    const leadScore = scoreLead(data);
    try {
      await admin.firestore().collection("inquiries").doc(event.params.docId).update({
        leadScore: leadScore,
      });
      console.log("Lead score set:", leadScore, "for inquiry:", event.params.docId);
    } catch (scoreErr) {
      console.error("Failed to set lead score:", scoreErr);
    }

    // --- Auto-reply to borrower ---
    const borrowerEmail = data.email;
    if (borrowerEmail) {
      const firstName = data.firstName || "there";

      const loanContext = {
        bridge: {
          detail: "bridge financing",
          note: "Bridge loans are our fastest-closing product — most deals fund within 7-14 days.",
        },
        "fix-flip": {
          detail: "fix & flip financing",
          note: "We work with lenders who fund both acquisition and rehab, with flexible draw schedules.",
        },
        construction: {
          detail: "new construction financing",
          note: "Our construction lending partners offer phased draws aligned to your build timeline.",
        },
        dscr: {
          detail: "DSCR rental loan financing",
          note: "DSCR loans qualify based on the property's rental income — no personal income docs required.",
        },
      };

      const ctx = loanContext[data.loanType] || {
        detail: "your financing needs",
        note: "We'll review your details and match you with the best lending options from our network.",
      };

      const stateText = data.propertyState ? ` in ${data.propertyState}` : "";
      const amountText = loanAmount !== "—" ? ` in the ${loanAmount} range` : "";

      const replyHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #2a2a2a;">
          <p>Hey ${escHtml(firstName)},</p>
          <p>It's Zach from Umbrella Place — I just saw your inquiry come through about ${escHtml(ctx.detail)}${escHtml(stateText)}${escHtml(amountText)} and wanted to reach out personally.</p>
          <p>${ctx.note}</p>
          <p>I'm going to review your deal details and pull together some options from our lender network. I'll follow up shortly with next steps. In the meantime, if you have any questions or want to share more details about the deal, just hit reply — this comes straight to me.</p>
          <p>Talk soon,</p>
          <p style="margin-top: 16px;">
            <strong>Zachary Smith</strong><br/>
            <span style="color: #5a6478; font-size: 13px;">Managing Partner, Umbrella Place</span><br/>
            <span style="color: #5a6478; font-size: 13px;">(850) 706-0145</span><br/>
            <span style="color: #5a6478; font-size: 13px;">zachary@umbrellaplace.com</span>
          </p>
          <hr style="border: none; border-top: 1px solid #e2e6ed; margin: 24px 0 16px;">
          <p style="font-size: 11px; color: #8a94a6;">
            Umbrella Place is a loan brokerage and does not make loans directly. All loans are subject to lender approval.
          </p>
        </div>
      `;

      const replyOptions = {
        from: `"Zachary Smith | Umbrella Place" <${gmailUser.value()}>`,
        replyTo: "zachary@umbrellaplace.com",
        to: borrowerEmail,
        subject: `Re: Your ${loanType} inquiry — Zach from Umbrella Place`,
        html: replyHtml,
      };

      try {
        await transporter.sendMail(replyOptions);
        console.log("Auto-reply sent to borrower:", borrowerEmail);

        // Log auto-reply in emails subcollection for dashboard tracking
        const replyBody = `It's Zach from Umbrella Place — I just saw your inquiry come through about ${ctx.detail}${stateText}${amountText} and wanted to reach out personally.\n\n${ctx.note}\n\nI'm going to review your deal details and pull together some options from our lender network. I'll follow up shortly with next steps. In the meantime, if you have any questions or want to share more details about the deal, just hit reply — this comes straight to me.`;

        await admin.firestore().collection("inquiries").doc(event.params.docId).collection("emails").add({
          from: "Zachary Smith",
          to: borrowerEmail,
          body: replyBody,
          type: "auto-reply",
          sentAt: new Date().toISOString(),
          sentBy: "inbound-agent",
        });
      } catch (replyErr) {
        console.error("Failed to send auto-reply:", replyErr);
      }
    }

    // --- Append to Google Sheet ---
    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      const sheets = google.sheets({ version: "v4", auth });

      const row = [
        submittedDate,
        name,
        data.email || "",
        data.phone || "",
        loanType,
        data.propertyType || "",
        data.loanPurpose || "",
        loanAmount,
        data.propertyState || "",
        data.creditScore || "",
        timeline,
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId.value(),
        range: "Inbound Leads!A:K",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [row],
        },
      });

      console.log("Row appended to Google Sheet for inquiry:", event.params.docId);
    } catch (err) {
      console.error("Failed to append to Google Sheet:", err);
    }
  }
);

// --- AI Chat Endpoint ---
const anthropicKey = defineString("ANTHROPIC_API_KEY");

const CHAT_SYSTEM_PROMPT = `You are an AI loan advisor for Umbrella Place, a private real estate loan brokerage. You help real estate investors understand their financing options and guide them toward submitting a deal for review.

ABOUT UMBRELLA PLACE:
- Private real estate loan brokerage (not a direct lender)
- Connects borrowers with 50+ private lenders, funds, and institutional capital sources
- Serves 48 states
- No upfront fees — brokerage fee is earned at closing and disclosed upfront
- Typical closings in 7-14 days
- Founded by Zachary Smith (Florida) and Cole Smith (Utah), both Managing Partners

LOAN PRODUCTS:

1. BRIDGE LOANS
- Short-term financing (6-24 months, typically 12)
- Rates vary by lender and deal — depend on LTV, property type, and exit strategy
- Interest-only payments
- Close in 7-14 days
- Qualified based on the deal, not personal income
- Best for: quick acquisitions, properties needing rehab before refinance, time-sensitive deals

2. FIX & FLIP LOANS
- Acquisition + rehab funding in one loan
- Rates are lender-specific — influenced by experience, ARV, and rehab scope
- Interest-only, 6-18 month terms
- Up to 85-90% of purchase price, 100% of rehab
- Draw schedule for rehab funds (holdback model)
- Best for: residential flips, value-add renovations
- Key metric: 70% rule (purchase + rehab should not exceed 70% of ARV)

3. NEW CONSTRUCTION LOANS
- Ground-up construction financing
- Rates depend on the lender, builder experience, and project scope
- Phased draw schedule aligned to build timeline
- 12-24 month terms
- Best for: spec homes, townhomes, multi-family builds, tear-down/rebuild
- Borrower experience matters — lenders prefer builders with completed projects

4. DSCR RENTAL LOANS
- Long-term financing (30-year, fixed or ARM)
- Rates vary by lender — driven by DSCR ratio, credit, and LTV
- Principal & interest payments (fully amortizing)
- Qualified on rental income vs. mortgage payment (DSCR ratio)
- DSCR of 1.0+ required, better terms at 1.25+
- No tax returns or employment verification needed
- Close in 21-30 days
- Best for: rental purchases, refinances, portfolio building, BRRRR strategy exit

COMMON TERMS:
- ARV: After Repair Value — estimated value after renovations
- LTV: Loan-to-Value ratio
- LTC: Loan-to-Cost ratio
- DSCR: Debt Service Coverage Ratio = monthly rent / monthly mortgage payment (PITIA)
- Points: Origination fees, typically 1-3 points (1 point = 1% of loan amount)
- Draw schedule: Phased release of rehab/construction funds after inspections
- BRRRR: Buy, Rehab, Rent, Refinance, Repeat strategy

BEHAVIOR GUIDELINES:
- Be helpful, knowledgeable, and conversational — like a loan officer having a friendly chat
- Keep responses concise (2-4 sentences for simple questions, longer for complex explanations)
- When you have enough deal context, encourage them to submit through the intake form on the website
- NEVER quote specific rate ranges or percentages — rates are lender-dependent and deal-specific. Say "rates vary by lender and deal details" and encourage submitting for a real quote
- Never guarantee approval or terms — always say "typically," "generally," or "depending on the deal"
- If asked about something outside private real estate lending, politely redirect
- Never reveal that you are an AI unless directly asked. If asked, be honest.
- Do not make up information. If unsure, say you'd recommend speaking with Zachary or Cole directly.
- For specific deal questions, you can give general guidance but recommend submitting for a formal review`;

const ALLOWED_ORIGINS = [
  "https://umbrellaplace.com",
  "https://www.umbrellaplace.com",
  "https://umbrellaplace.web.app",
  "https://umbrellaplace-59c7d.web.app",
  "https://umbrellaplace-59c7d.firebaseapp.com",
];

// --- Submit Inquiry (with reCAPTCHA + field validation) ---
const recaptchaSecret = defineString("RECAPTCHA_SECRET");

exports.submitInquiry = onRequest(
  { cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const data = req.body;

    // Validate required fields
    if (!data.firstName || typeof data.firstName !== "string" || data.firstName.trim().length === 0) {
      res.status(400).json({ error: "First name is required" });
      return;
    }
    if (!data.email && !data.phone) {
      res.status(400).json({ error: "Email or phone is required" });
      return;
    }

    // Validate email format if provided
    if (data.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.email)) {
        res.status(400).json({ error: "Invalid email format" });
        return;
      }
    }

    // Validate field lengths to prevent abuse
    const maxLen = 500;
    const stringFields = ["firstName", "lastName", "email", "phone", "loanType", "propertyType", "loanPurpose", "loanAmount", "propertyState", "creditScore", "timeline"];
    for (const field of stringFields) {
      if (data[field] && (typeof data[field] !== "string" || data[field].length > maxLen)) {
        res.status(400).json({ error: `Invalid field: ${field}` });
        return;
      }
    }

    // Verify reCAPTCHA token
    const token = data.recaptchaToken;
    if (!token) {
      res.status(400).json({ error: "reCAPTCHA verification required" });
      return;
    }

    try {
      const recaptchaRes = await fetch(
        `https://www.google.com/recaptcha/api/siteverify?secret=${recaptchaSecret.value()}&response=${encodeURIComponent(token)}`,
        { method: "POST" }
      );
      const recaptchaData = await recaptchaRes.json();

      if (!recaptchaData.success || recaptchaData.score < 0.3 || recaptchaData.action !== "submit_inquiry") {
        console.warn("reCAPTCHA failed:", recaptchaData);
        res.status(403).json({ error: "reCAPTCHA verification failed" });
        return;
      }
    } catch (err) {
      console.error("reCAPTCHA verification error:", err);
      res.status(500).json({ error: "reCAPTCHA verification error" });
      return;
    }

    // Build sanitized document (only allow known fields)
    const inquiry = {
      firstName: data.firstName.trim(),
      lastName: (data.lastName || "").trim(),
      email: (data.email || "").trim(),
      phone: (data.phone || "").trim(),
      loanType: (data.loanType || "").trim(),
      propertyType: (data.propertyType || "").trim(),
      loanPurpose: (data.loanPurpose || "").trim(),
      loanAmount: (data.loanAmount || "").trim(),
      propertyState: (data.propertyState || "").trim(),
      creditScore: (data.creditScore || "").trim(),
      timeline: (data.timeline || "").trim(),
      submittedAt: new Date().toISOString(),
      status: "new",
    };

    try {
      const docRef = await admin.firestore().collection("inquiries").add(inquiry);
      res.status(200).json({ success: true, id: docRef.id });
    } catch (err) {
      console.error("Failed to save inquiry:", err);
      res.status(500).json({ error: "Failed to save inquiry" });
    }
  }
);

exports.chat = onRequest(
  {
    cors: ALLOWED_ORIGINS,
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    // Input validation: limit message count and length
    if (messages.length > 20) {
      res.status(400).json({ error: "Too many messages (max 20)" });
      return;
    }
    for (const msg of messages) {
      if (!msg.role || !["user", "assistant"].includes(msg.role)) {
        res.status(400).json({ error: "Invalid message role" });
        return;
      }
      if (typeof msg.content !== "string" || msg.content.length > 2000) {
        res.status(400).json({ error: "Message content too long (max 2000 chars)" });
        return;
      }
    }

    try {
      const client = new Anthropic({ apiKey: anthropicKey.value() });

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: CHAT_SYSTEM_PROMPT,
        messages: messages,
      });

      const text = response.content[0]?.text || "";
      res.status(200).json({ reply: text });
    } catch (err) {
      console.error("Chat error:", err);
      res.status(500).json({ error: "Failed to get response" });
    }
  }
);

// ===== ADMIN DASHBOARD FUNCTIONS =====

// Helper: verify Firebase Auth token
async function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }
  const token = authHeader.split("Bearer ")[1];
  return admin.auth().verifyIdToken(token);
}

// HTML-encode helper to prevent injection in emails
function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Update Inquiry Status ---
exports.updateInquiryStatus = onRequest(
  { cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      await verifyAuth(req);
    } catch (e) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { inquiryId, status } = req.body;
    const validStatuses = ["new", "contacted", "in-progress", "closed-won", "closed-lost"];
    if (!inquiryId || !validStatuses.includes(status)) {
      res.status(400).json({ error: "Invalid inquiryId or status" });
      return;
    }

    try {
      await admin.firestore().collection("inquiries").doc(inquiryId).update({
        status: status,
        updatedAt: new Date().toISOString(),
      });
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("Update status error:", err);
      res.status(500).json({ error: "Failed to update status" });
    }
  }
);

// --- Send Reply Email ---
exports.sendReply = onRequest(
  { cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    let decodedToken;
    try {
      decodedToken = await verifyAuth(req);
    } catch (e) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { inquiryId, emailBody, toEmail, leadName, senderKey } = req.body;
    if (!inquiryId || !emailBody || !toEmail) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    // Verify toEmail matches the inquiry's actual email (prevent open relay)
    try {
      const inquiryDoc = await admin.firestore().collection("inquiries").doc(inquiryId).get();
      if (!inquiryDoc.exists) {
        res.status(404).json({ error: "Inquiry not found" });
        return;
      }
      if (inquiryDoc.data().email !== toEmail) {
        res.status(400).json({ error: "Email does not match inquiry" });
        return;
      }
    } catch (lookupErr) {
      res.status(500).json({ error: "Failed to verify inquiry" });
      return;
    }

    // Sender profiles with full signatures
    const senders = {
      zachary: {
        name: "Zachary Smith",
        email: "zachary@umbrellaplace.com",
        phone: "(850) 706-0145",
        location: "Florida",
      },
      cole: {
        name: "Cole Smith",
        email: "csmith@umbrellaplace.com",
        phone: "(801) 613-2659",
        location: "Utah",
      },
    };

    const sender = senders[senderKey] || senders.zachary;

    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser.value(), pass: gmailPass.value() },
      });

      const replyHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #2a2a2a;">
          <p>Hey ${escHtml(leadName || "there")},</p>
          ${emailBody.split("\n").filter(l => l.trim()).map(line => `<p>${escHtml(line)}</p>`).join("")}
          <p style="margin-top: 16px;">
            <strong>${sender.name}</strong><br/>
            <span style="color: #5a6478; font-size: 13px;">Managing Partner, Umbrella Place</span><br/>
            <span style="color: #5a6478; font-size: 13px;">${sender.phone}</span><br/>
            <span style="color: #5a6478; font-size: 13px;">${sender.email}</span>
          </p>
          <hr style="border: none; border-top: 1px solid #e2e6ed; margin: 24px 0 16px;">
          <p style="font-size: 11px; color: #8a94a6;">
            Umbrella Place is a loan brokerage and does not make loans directly. All loans are subject to lender approval.
          </p>
        </div>
      `;

      await transporter.sendMail({
        from: `"${sender.name} | Umbrella Place" <${gmailUser.value()}>`,
        replyTo: sender.email,
        to: toEmail,
        subject: `Following up — ${sender.name} from Umbrella Place`,
        html: replyHtml,
      });

      // Store email in subcollection
      await admin.firestore().collection("inquiries").doc(inquiryId).collection("emails").add({
        from: sender.name,
        to: toEmail,
        body: emailBody,
        type: "outbound",
        sentAt: new Date().toISOString(),
        sentBy: decodedToken.email,
      });

      // Update inquiry status to contacted if still new
      const inquiry = await admin.firestore().collection("inquiries").doc(inquiryId).get();
      if (inquiry.exists && (!inquiry.data().status || inquiry.data().status === "new")) {
        await admin.firestore().collection("inquiries").doc(inquiryId).update({
          status: "contacted",
          lastContactedAt: new Date().toISOString(),
        });
      }

      console.log("Reply sent to:", toEmail);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("Send reply error:", err);
      res.status(500).json({ error: "Failed to send email" });
    }
  }
);

// --- AI Draft Reply ---
exports.aiDraftReply = onRequest(
  { cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      await verifyAuth(req);
    } catch (e) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { firstName, loanType, loanAmount, propertyState, timeline, creditScore } = req.body;

    const loanTypeLabel = {
      bridge: "Bridge Loan", "fix-flip": "Fix & Flip",
      construction: "New Construction", dscr: "DSCR Rental Loan",
    }[loanType] || loanType || "private real estate financing";

    try {
      const client = new Anthropic({ apiKey: anthropicKey.value() });

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: `You are Zachary Smith, Managing Partner at Umbrella Place, a private real estate loan brokerage. Write a brief, personal follow-up email to a potential borrower. Be warm, knowledgeable, and direct. 2-3 short paragraphs max. Do NOT include a greeting (like "Hey Name") or signature — those are added automatically. Focus on: acknowledging their specific deal, providing one useful insight about their loan type, and a clear next step.`,
        messages: [{
          role: "user",
          content: `Draft a follow-up email for this lead:\n- Name: ${firstName || "there"}\n- Loan Type: ${loanTypeLabel}\n- Loan Amount: ${loanAmount || "not specified"}\n- Property State: ${propertyState || "not specified"}\n- Timeline: ${timeline || "not specified"}\n- Credit Score: ${creditScore || "not specified"}`,
        }],
      });

      const draft = response.content[0]?.text || "";
      res.status(200).json({ draft });
    } catch (err) {
      console.error("AI draft error:", err);
      res.status(500).json({ error: "Failed to generate draft" });
    }
  }
);

