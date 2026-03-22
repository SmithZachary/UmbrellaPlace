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

    function fmtDollar(val) {
      if (!val) return "—";
      if (loanAmountLabels[val]) return loanAmountLabels[val];
      const num = parseInt(val, 10);
      if (!isNaN(num)) return "$" + num.toLocaleString("en-US");
      return val;
    }

    const name = [data.firstName, data.lastName].filter(Boolean).join(" ");
    const loanType = loanTypeLabels[data.loanType] || data.loanType || "—";
    const loanAmount = fmtDollar(data.loanAmount);
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
            ${data.afterRepairValue ? `<tr><td style="padding: 6px 0; color: #5a6478;">After Repair Value</td><td style="padding: 6px 0;">${escHtml(fmtDollar(data.afterRepairValue))}</td></tr>` : ""}
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
    const stringFields = ["firstName", "lastName", "email", "phone", "loanType", "propertyType", "loanPurpose", "loanAmount", "propertyState", "creditScore", "timeline", "afterRepairValue"];
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
      afterRepairValue: (data.afterRepairValue || "").trim(),
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

// ===== SOCIAL MEDIA AGENT =====
exports.generateSocialPost = onRequest(
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

    const { platform, topic, tone } = req.body;
    if (!platform || !topic) {
      res.status(400).json({ error: "Platform and topic are required" });
      return;
    }

    const platformGuide = {
      linkedin: "LinkedIn: Professional tone, 1-3 paragraphs, use line breaks for readability. Include a call-to-action. No hashtags in the body — add 3-5 relevant hashtags at the end.",
      facebook: "Facebook: Conversational and approachable. 2-4 sentences, can be slightly longer. Include a question or CTA to drive engagement. 1-2 hashtags max.",
      instagram: "Instagram: Visual storytelling caption. Start with a hook. Use short paragraphs with line breaks. Include a CTA. Add 10-15 relevant hashtags at the end separated by a line break.",
      x: "X (Twitter): Under 280 characters. Punchy, direct, value-packed. 1-2 hashtags max. Can use thread format for complex topics (separate tweets with ---).",
    };

    try {
      const client = new Anthropic({ apiKey: anthropicKey.value() });

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: `You are the social media content creator for Umbrella Place, a private real estate loan brokerage. You create engaging, educational content about real estate investing and private lending.

BRAND VOICE: Knowledgeable, approachable, confident but not pushy. Position Umbrella Place as a trusted guide for real estate investors.

ABOUT UMBRELLA PLACE:
- Private real estate loan brokerage connecting investors with 50+ lenders
- Products: Bridge loans, fix & flip, new construction, DSCR rental loans
- Close in 7-14 days, no upfront fees, 48 states
- Founded by Zachary Smith and Cole Smith

RULES:
- Never quote specific rates or percentages
- Focus on education, value, and thought leadership
- Include subtle brand mentions without being overly promotional
- Write content that real estate investors would want to share
- ${platformGuide[platform] || "Write platform-appropriate content."}`,
        messages: [{
          role: "user",
          content: `Generate a ${platform} post about: ${topic}\nTone: ${tone || "professional and educational"}`,
        }],
      });

      const content = response.content[0]?.text || "";

      // Save to Firestore
      const postDoc = await admin.firestore().collection("social-posts").add({
        platform,
        topic,
        tone: tone || "professional",
        content,
        status: "draft",
        generatedAt: new Date().toISOString(),
        generatedBy: "social-agent",
      });

      res.status(200).json({ content, postId: postDoc.id });
    } catch (err) {
      console.error("Social post generation error:", err);
      res.status(500).json({ error: "Failed to generate post" });
    }
  }
);

// ===== WEB SCOUT AGENT =====
exports.analyzeOpportunity = onRequest(
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

    const { source, url, description } = req.body;
    if (!description) {
      res.status(400).json({ error: "Description is required" });
      return;
    }

    try {
      const client = new Anthropic({ apiKey: anthropicKey.value() });

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: `You are a lead intelligence analyst for Umbrella Place, a private real estate loan brokerage. You analyze online conversations and posts from real estate forums, Reddit, BiggerPockets, etc. to identify potential borrowers.

Your job is to:
1. Determine if the person is a potential lead for private lending (bridge, fix & flip, construction, DSCR)
2. Score the opportunity 1-10 (10 = highly likely to need private lending soon)
3. Identify the likely loan type they need
4. Summarize what they're looking for
5. Suggest the best approach to engage them

Respond in this exact JSON format:
{"score": <number>, "loanType": "<type>", "summary": "<1-2 sentences>", "approach": "<1-2 sentences on how to engage>", "signals": ["<signal1>", "<signal2>"]}`,
        messages: [{
          role: "user",
          content: `Analyze this online conversation/post for lead potential:\n\nSource: ${source || "Unknown"}\nURL: ${url || "N/A"}\nContent: ${description}`,
        }],
      });

      const text = response.content[0]?.text || "{}";
      let analysis;
      try {
        analysis = JSON.parse(text);
      } catch {
        analysis = { score: 0, summary: text, loanType: "unknown", approach: "", signals: [] };
      }

      // Save to Firestore
      const oppDoc = await admin.firestore().collection("scout-opportunities").add({
        source: source || "manual",
        url: url || "",
        description,
        analysis,
        score: analysis.score || 0,
        status: "new",
        discoveredAt: new Date().toISOString(),
        addedBy: "scout-agent",
      });

      res.status(200).json({ analysis, opportunityId: oppDoc.id });
    } catch (err) {
      console.error("Opportunity analysis error:", err);
      res.status(500).json({ error: "Failed to analyze opportunity" });
    }
  }
);

// ===== ENGAGEMENT AGENT =====
exports.draftEngagement = onRequest(
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

    const { opportunityId, platform, context } = req.body;
    if (!context) {
      res.status(400).json({ error: "Context is required" });
      return;
    }

    try {
      const client = new Anthropic({ apiKey: anthropicKey.value() });

      const platformTone = {
        reddit: "Reddit-appropriate: helpful, not salesy. Answer their question with genuine expertise. Mention you work in private lending only if relevant. Never link-drop.",
        biggerpockets: "BiggerPockets style: knowledgeable investor peer. Share real insights. You can mention you broker private loans if directly relevant to their question.",
        facebook: "Facebook group friendly: conversational, helpful. Share expertise naturally. Can mention Umbrella Place if they're asking for lender recommendations.",
        linkedin: "LinkedIn professional: thought-leader tone. Provide value-first insights. Can be more direct about your brokerage services.",
        other: "Be helpful and genuine. Provide real value. Only mention Umbrella Place if naturally relevant.",
      };

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: `You are Zachary Smith, Managing Partner at Umbrella Place (private real estate loan brokerage). You're drafting a response to engage with a potential lead found online.

YOUR EXPERTISE: Bridge loans, fix & flip financing, new construction loans, DSCR rental loans. 50+ lender network, close in 7-14 days, no upfront fees, 48 states.

TONE: ${platformTone[platform] || platformTone.other}

RULES:
- Lead with value — answer their question or solve their problem first
- Never be spammy or overtly promotional
- Sound like a real person, not a bot
- Keep it concise (2-4 sentences for short-form, up to a paragraph for forums)
- Never quote specific rates`,
        messages: [{
          role: "user",
          content: `Draft a response to engage this potential lead:\n\nPlatform: ${platform || "online forum"}\nContext: ${context}`,
        }],
      });

      const draft = response.content[0]?.text || "";

      // Save draft
      const draftDoc = await admin.firestore().collection("engagement-drafts").add({
        opportunityId: opportunityId || "",
        platform: platform || "other",
        context,
        draft,
        status: "pending",
        createdAt: new Date().toISOString(),
        createdBy: "engagement-agent",
      });

      res.status(200).json({ draft, draftId: draftDoc.id });
    } catch (err) {
      console.error("Engagement draft error:", err);
      res.status(500).json({ error: "Failed to generate draft" });
    }
  }
);

// ===== SAVE AGENT CONFIG =====
exports.saveAgentConfig = onRequest(
  { cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try { await verifyAuth(req); } catch (e) { res.status(401).json({ error: "Unauthorized" }); return; }

    const { agent, config } = req.body;
    if (!agent || !config) { res.status(400).json({ error: "Agent name and config required" }); return; }

    try {
      await admin.firestore().collection("agent-config").doc(agent).set(config, { merge: true });
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("Save agent config error:", err);
      res.status(500).json({ error: "Failed to save config" });
    }
  }
);

// ===== RUN SOCIAL MEDIA AGENT (batch) =====
exports.runSocialAgent = onRequest(
  { cors: ALLOWED_ORIGINS, timeoutSeconds: 300 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try { await verifyAuth(req); } catch (e) { res.status(401).json({ error: "Unauthorized" }); return; }

    try {
      // Load config
      const configDoc = await admin.firestore().collection("agent-config").doc("social").get();
      const config = configDoc.exists ? configDoc.data() : {};
      const topics = (config.topics || "").split("\n").map(t => t.trim()).filter(Boolean);
      const platforms = config.platforms || ["linkedin", "facebook", "instagram", "x"];
      const toneNotes = config.tone || "Professional and educational";

      if (topics.length === 0) {
        res.status(400).json({ error: "No topics configured. Add topics in the configuration panel." });
        return;
      }

      const client = new Anthropic({ apiKey: anthropicKey.value() });
      const results = [];

      const platformGuide = {
        linkedin: "LinkedIn: Professional tone, 1-3 paragraphs, line breaks for readability. Call-to-action. 3-5 hashtags at the end.",
        facebook: "Facebook: Conversational, 2-4 sentences. Question or CTA for engagement. 1-2 hashtags max.",
        instagram: "Instagram: Visual storytelling caption. Hook first. Short paragraphs. CTA. 10-15 hashtags at end.",
        x: "X (Twitter): Under 280 characters. Punchy, direct. 1-2 hashtags max.",
        substack: "Substack: Newsletter-style, 3-5 paragraphs. Educational deep-dive. Include actionable takeaways. No hashtags.",
      };

      // Pick a random topic for each platform
      for (const platform of platforms) {
        const topic = topics[Math.floor(Math.random() * topics.length)];
        try {
          const response = await client.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 600,
            system: `You are the social media content creator for Umbrella Place, a private real estate loan brokerage. Create engaging, educational content about real estate investing and private lending.\n\nBRAND VOICE: ${toneNotes}\n\nABOUT: Private real estate loan brokerage, 50+ lenders, bridge/fix-flip/construction/DSCR loans, close in 7-14 days, no upfront fees, 48 states. Founded by Zachary Smith and Cole Smith.\n\nRULES: Never quote specific rates. Focus on education and value. Subtle brand mentions. ${platformGuide[platform] || "Write platform-appropriate content."}`,
            messages: [{ role: "user", content: `Generate a ${platform} post about: ${topic}\nTone: ${toneNotes}` }],
          });
          const content = response.content[0]?.text || "";
          const doc = await admin.firestore().collection("social-posts").add({
            platform, topic, tone: toneNotes, content,
            status: "queued", generatedAt: new Date().toISOString(), generatedBy: "social-agent-batch",
          });
          results.push({ platform, topic, postId: doc.id });
        } catch (genErr) {
          console.error(`Social agent: failed for ${platform}:`, genErr.message);
          results.push({ platform, topic, error: genErr.message });
        }
      }

      // Log activity
      await admin.firestore().collection("agent-activity").add({
        agent: "social", action: "batch-generate",
        details: `Generated ${results.filter(r => !r.error).length} posts across ${platforms.length} platforms`,
        results, timestamp: new Date().toISOString(),
      });

      // Update last run
      await admin.firestore().collection("agent-config").doc("social").set(
        { lastRun: new Date().toISOString() }, { merge: true }
      );

      res.status(200).json({ success: true, generated: results.filter(r => !r.error).length, results });
    } catch (err) {
      console.error("Run social agent error:", err);
      res.status(500).json({ error: "Failed to run social agent" });
    }
  }
);

// ===== RUN WEB SCOUT AGENT (Reddit scan) =====
exports.runScoutAgent = onRequest(
  { cors: ALLOWED_ORIGINS, timeoutSeconds: 300 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try { await verifyAuth(req); } catch (e) { res.status(401).json({ error: "Unauthorized" }); return; }

    try {
      const configDoc = await admin.firestore().collection("agent-config").doc("scout").get();
      const config = configDoc.exists ? configDoc.data() : {};
      const keywords = (config.keywords || "").split("\n").map(k => k.trim()).filter(Boolean);
      const subreddits = (config.subreddits || "").split("\n").map(s => s.trim()).filter(Boolean);
      const minScore = parseInt(config.minScore) || 5;
      const period = config.period || "week";

      if (keywords.length === 0 || subreddits.length === 0) {
        res.status(400).json({ error: "Configure keywords and subreddits first." });
        return;
      }

      // Get existing opportunity URLs to avoid duplicates
      const existingSnap = await admin.firestore().collection("scout-opportunities")
        .orderBy("discoveredAt", "desc").limit(200).get();
      const existingUrls = new Set(existingSnap.docs.map(d => d.data().url).filter(Boolean));

      const client = new Anthropic({ apiKey: anthropicKey.value() });
      const results = [];
      let found = 0;

      // Scan Reddit — pick up to 3 keyword/subreddit combos to stay within timeout
      const combos = [];
      for (const sub of subreddits) {
        for (const kw of keywords) {
          combos.push({ sub, kw });
        }
      }
      // Shuffle and take first 5 combos
      for (let i = combos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [combos[i], combos[j]] = [combos[j], combos[i]];
      }
      const selectedCombos = combos.slice(0, 5);

      for (const { sub, kw } of selectedCombos) {
        try {
          const redditUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?q=${encodeURIComponent(kw)}&sort=new&limit=5&t=${period}&restrict_sr=on`;
          const redditRes = await fetch(redditUrl, {
            headers: { "User-Agent": "UmbrellaPlace/1.0 (lead-scout)" },
          });

          if (!redditRes.ok) continue;
          const redditData = await redditRes.json();
          const posts = (redditData.data?.children || []).filter(p => p.kind === "t3");

          for (const post of posts) {
            const data = post.data;
            const postUrl = `https://www.reddit.com${data.permalink}`;
            if (existingUrls.has(postUrl)) continue;
            existingUrls.add(postUrl);

            const postText = `Title: ${data.title}\n\n${(data.selftext || "").slice(0, 1000)}`;

            // Analyze with AI
            const analysisRes = await client.messages.create({
              model: "claude-sonnet-4-20250514",
              max_tokens: 400,
              system: `You are a lead intelligence analyst for Umbrella Place, a private real estate loan brokerage. Analyze this Reddit post to determine if the poster could be a lead for private lending (bridge, fix & flip, construction, DSCR).\n\nScore 1-10 (10 = highly likely to need private lending soon). Respond in JSON:\n{"score": <number>, "loanType": "<type>", "summary": "<1-2 sentences>", "approach": "<how to engage>", "signals": ["<signal1>", "<signal2>"]}`,
              messages: [{ role: "user", content: `Analyze for lead potential:\n\nSubreddit: r/${sub}\nPost: ${postText}` }],
            });

            let analysis;
            try {
              analysis = JSON.parse(analysisRes.content[0]?.text || "{}");
            } catch {
              analysis = { score: 0, summary: "Could not analyze", loanType: "unknown", approach: "", signals: [] };
            }

            if (analysis.score >= minScore) {
              const oppDoc = await admin.firestore().collection("scout-opportunities").add({
                source: "reddit", subreddit: sub, url: postUrl,
                title: data.title, description: postText,
                author: data.author, analysis,
                score: analysis.score || 0, status: "new",
                discoveredAt: new Date().toISOString(), addedBy: "scout-agent-batch",
              });
              results.push({ url: postUrl, score: analysis.score, loanType: analysis.loanType, id: oppDoc.id });
              found++;
            }
          }
        } catch (scanErr) {
          console.error(`Scout: error scanning r/${sub} for "${kw}":`, scanErr.message);
        }
      }

      // Log activity
      await admin.firestore().collection("agent-activity").add({
        agent: "scout", action: "reddit-scan",
        details: `Scanned ${selectedCombos.length} keyword/subreddit combos, found ${found} opportunities (score >= ${minScore})`,
        results, timestamp: new Date().toISOString(),
      });

      await admin.firestore().collection("agent-config").doc("scout").set(
        { lastRun: new Date().toISOString() }, { merge: true }
      );

      res.status(200).json({ success: true, scanned: selectedCombos.length, found, results });
    } catch (err) {
      console.error("Run scout agent error:", err);
      res.status(500).json({ error: "Failed to run scout agent" });
    }
  }
);

// ===== RUN ENGAGEMENT AGENT (batch draft) =====
exports.runEngagementAgent = onRequest(
  { cors: ALLOWED_ORIGINS, timeoutSeconds: 300 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try { await verifyAuth(req); } catch (e) { res.status(401).json({ error: "Unauthorized" }); return; }

    try {
      const configDoc = await admin.firestore().collection("agent-config").doc("engagement").get();
      const config = configDoc.exists ? configDoc.data() : {};
      const minScore = parseInt(config.minScore) || 7;
      const toneNotes = config.tone || "Helpful, genuine, lead with value";

      // Get new opportunities that haven't been engaged yet
      const oppsSnap = await admin.firestore().collection("scout-opportunities")
        .where("status", "==", "new")
        .orderBy("score", "desc")
        .limit(10)
        .get();

      if (oppsSnap.empty) {
        res.status(200).json({ success: true, drafted: 0, message: "No new opportunities to engage with." });
        return;
      }

      const client = new Anthropic({ apiKey: anthropicKey.value() });
      const results = [];
      let drafted = 0;

      const platformTone = {
        reddit: "Reddit-appropriate: helpful, not salesy. Answer with genuine expertise. Mention private lending only if relevant. Never link-drop.",
        biggerpockets: "BiggerPockets style: knowledgeable investor peer. Share real insights.",
        facebook: "Facebook group friendly: conversational, helpful.",
        linkedin: "LinkedIn professional: thought-leader tone.",
        other: "Be helpful and genuine. Provide real value.",
      };

      for (const doc of oppsSnap.docs) {
        const opp = doc.data();
        if (opp.score < minScore) continue;

        const platform = opp.source || "other";
        const context = opp.description || opp.title || "";

        try {
          const response = await client.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 400,
            system: `You are Zachary Smith, Managing Partner at Umbrella Place (private real estate loan brokerage). Draft a response to engage a potential lead found online.\n\nEXPERTISE: Bridge loans, fix & flip, construction, DSCR rental loans. 50+ lenders, close in 7-14 days, no upfront fees, 48 states.\n\nTONE: ${platformTone[platform] || platformTone.other}. ${toneNotes}\n\nRULES: Lead with value. Never spammy. Sound like a real person. Concise. Never quote specific rates.`,
            messages: [{ role: "user", content: `Draft a response for this ${platform} conversation:\n\n${context.slice(0, 1500)}` }],
          });

          const draft = response.content[0]?.text || "";
          const draftDoc = await admin.firestore().collection("engagement-drafts").add({
            opportunityId: doc.id, platform, context: context.slice(0, 500),
            draft, status: "pending",
            oppUrl: opp.url || "", oppTitle: opp.title || "",
            createdAt: new Date().toISOString(), createdBy: "engagement-agent-batch",
          });

          // Mark opportunity as engaged
          await admin.firestore().collection("scout-opportunities").doc(doc.id).update({ status: "engaged" });

          results.push({ opportunityId: doc.id, draftId: draftDoc.id, platform });
          drafted++;
        } catch (draftErr) {
          console.error("Engagement agent: draft error:", draftErr.message);
        }
      }

      await admin.firestore().collection("agent-activity").add({
        agent: "engagement", action: "batch-draft",
        details: `Drafted ${drafted} responses for ${oppsSnap.size} opportunities`,
        results, timestamp: new Date().toISOString(),
      });

      await admin.firestore().collection("agent-config").doc("engagement").set(
        { lastRun: new Date().toISOString() }, { merge: true }
      );

      res.status(200).json({ success: true, drafted, results });
    } catch (err) {
      console.error("Run engagement agent error:", err);
      res.status(500).json({ error: "Failed to run engagement agent" });
    }
  }
);

