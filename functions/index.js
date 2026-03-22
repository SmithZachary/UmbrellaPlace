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
            <tr><td style="padding: 6px 0; color: #5a6478; width: 140px;">Name</td><td style="padding: 6px 0; font-weight: 600;">${name}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Email</td><td style="padding: 6px 0;">${data.email || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Phone</td><td style="padding: 6px 0;">${data.phone || "—"}</td></tr>
          </table>
          <hr style="border: none; border-top: 1px solid #e2e6ed; margin: 16px 0;">
          <h3 style="color: #1a3c6e; margin: 0 0 16px; font-size: 16px;">Deal Details</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr><td style="padding: 6px 0; color: #5a6478; width: 140px;">Loan Type</td><td style="padding: 6px 0;">${loanType}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Property Type</td><td style="padding: 6px 0;">${data.propertyType || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Loan Purpose</td><td style="padding: 6px 0;">${data.loanPurpose || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Loan Amount</td><td style="padding: 6px 0;">${loanAmount}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Property State</td><td style="padding: 6px 0;">${data.propertyState || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Credit Score</td><td style="padding: 6px 0;">${data.creditScore || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #5a6478;">Timeline</td><td style="padding: 6px 0;">${timeline}</td></tr>
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
          <p>Hey ${firstName},</p>
          <p>It's Zach from Umbrella Place — I just saw your inquiry come through about ${ctx.detail}${stateText}${amountText} and wanted to reach out personally.</p>
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
- Rates: 9-13%
- Interest-only payments
- Close in 7-14 days
- Qualified based on the deal, not personal income
- Best for: quick acquisitions, properties needing rehab before refinance, time-sensitive deals

2. FIX & FLIP LOANS
- Acquisition + rehab funding in one loan
- Rates: 9-13%
- Interest-only, 6-18 month terms
- Up to 85-90% of purchase price, 100% of rehab
- Draw schedule for rehab funds (holdback model)
- Best for: residential flips, value-add renovations
- Key metric: 70% rule (purchase + rehab should not exceed 70% of ARV)

3. NEW CONSTRUCTION LOANS
- Ground-up construction financing
- Rates: 10-14%
- Phased draw schedule aligned to build timeline
- 12-24 month terms
- Best for: spec homes, townhomes, multi-family builds, tear-down/rebuild
- Borrower experience matters — lenders prefer builders with completed projects

4. DSCR RENTAL LOANS
- Long-term financing (30-year, fixed or ARM)
- Rates: 6.5-9.5%
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
- Never guarantee approval, specific rates, or terms — always say "typical," "generally," or "depending on the deal"
- If asked about something outside private real estate lending, politely redirect
- Never reveal that you are an AI unless directly asked. If asked, be honest.
- Do not make up information. If unsure, say you'd recommend speaking with Zachary or Cole directly.
- For specific deal questions, you can give general guidance but recommend submitting for a formal review`;

exports.chat = onRequest(
  {
    cors: true,
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
