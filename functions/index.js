const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp, cert } = require("firebase-admin/app");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const { defineString } = require("firebase-functions/params");

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
