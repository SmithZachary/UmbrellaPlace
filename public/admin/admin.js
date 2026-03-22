// Umbrella Place Admin Dashboard
(function () {
  const auth = firebase.auth();
  const db = firebase.firestore();
  const FUNCTIONS_BASE = "https://us-central1-umbrellaplace-59c7d.cloudfunctions.net";

  // Label maps (same as Cloud Functions)
  const loanTypeLabels = {
    bridge: "Bridge Loan",
    "fix-flip": "Fix & Flip",
    construction: "New Construction",
    dscr: "DSCR Rental",
    other: "Other",
  };

  const loanAmountLabels = {
    "under-250k": "Under $250K",
    "250k-500k": "$250K - $500K",
    "500k-1m": "$500K - $1M",
    "1m-3m": "$1M - $3M",
    "3m-5m": "$3M - $5M",
    "5m-plus": "$5M+",
  };

  const timelineLabels = {
    asap: "ASAP (under 2 weeks)",
    "30-days": "Within 30 days",
    "60-days": "Within 60 days",
    exploring: "Just exploring",
  };

  const statusLabels = {
    new: "New",
    contacted: "Contacted",
    "in-progress": "In Progress",
    "closed-won": "Closed Won",
    "closed-lost": "Closed Lost",
  };

  // Sender profiles
  const senderProfiles = {
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

  // ===== AUTH GUARD =====
  let currentUser = null;
  let allLeads = [];
  let currentLeadId = null;

  auth.onAuthStateChanged((user) => {
    if (!user) {
      window.location.href = "login.html";
      return;
    }
    currentUser = user;
    document.getElementById("page-loading").style.display = "none";
    document.getElementById("dashboard").style.display = "flex";

    // Set user info in sidebar
    const name = user.email.includes("zachary") ? "Zachary Smith" :
                 user.email.includes("csmith") ? "Cole Smith" : user.email;
    const initials = name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
    document.getElementById("user-name").textContent = name;
    document.getElementById("user-email").textContent = user.email;
    document.getElementById("user-avatar").textContent = initials;

    // Set default sender based on logged-in user
    const senderSelect = document.getElementById("reply-sender");
    if (user.email.includes("csmith")) senderSelect.value = "cole";
    else senderSelect.value = "zachary";

    // Set date
    document.getElementById("topbar-date").textContent = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    loadLeads();
  });

  // ===== LOGOUT =====
  document.getElementById("btn-logout").addEventListener("click", () => {
    auth.signOut().then(() => window.location.href = "login.html");
  });

  // ===== NAVIGATION =====
  const navItems = document.querySelectorAll("[data-view]");
  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      const viewId = item.getAttribute("data-view");
      switchView(viewId);
    });
  });

  function switchView(viewId) {
    // Update nav active state
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    const activeNav = document.querySelector(`.nav-item[data-view="${viewId}"]`);
    if (activeNav) activeNav.classList.add("active");

    // Show view
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    const view = document.getElementById(`view-${viewId}`);
    if (view) view.classList.add("active");

    // Update topbar title
    const titles = {
      overview: "Overview",
      leads: "Leads",
      "agent-inbound": "Inbound Lead Agent",
      "agent-social": "Social Media Agent",
      "agent-scout": "Web Scout Agent",
      "agent-engage": "Engagement Agent",
    };
    document.getElementById("topbar-title").textContent = titles[viewId] || "Dashboard";

    // Close sidebar on mobile
    document.getElementById("sidebar").classList.remove("open");
  }

  // Mobile sidebar
  document.getElementById("mobile-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });

  // ===== LOAD LEADS =====
  async function loadLeads() {
    try {
      const snapshot = await db.collection("inquiries").orderBy("submittedAt", "desc").get();
      allLeads = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      renderOverview();
      renderLeadsTable(allLeads, "all-leads-table");
      renderLeadsTable(allLeads.slice(0, 5), "recent-leads-table");
      updateLeadsBadge();
      updateLeadsCount();
      renderInboundAgent();
    } catch (err) {
      console.error("Error loading leads:", err);
      showToast("Failed to load leads. Check Firestore rules.", "error");
    }
  }

  // ===== RENDER OVERVIEW =====
  function renderOverview() {
    const total = allLeads.length;
    const now = new Date();
    const thisMonth = allLeads.filter((l) => {
      const d = parseDate(l.submittedAt);
      return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const newLeads = allLeads.filter((l) => !l.status || l.status === "new");
    const won = allLeads.filter((l) => l.status === "closed-won");

    document.getElementById("stat-total").textContent = total;
    document.getElementById("stat-month").textContent = thisMonth.length;
    document.getElementById("stat-month-sub").textContent = now.toLocaleString("en-US", { month: "long", year: "numeric" });
    document.getElementById("stat-new").textContent = newLeads.length;
    document.getElementById("stat-won").textContent = won.length;
    const rate = total > 0 ? ((won.length / total) * 100).toFixed(1) : 0;
    document.getElementById("stat-won-sub").textContent = `${rate}% conversion`;

    renderCharts();
  }

  // ===== CHARTS =====
  let leadsTimeChart = null;
  let loanTypeChart = null;

  function renderCharts() {
    // Leads over time (last 12 weeks)
    const weeks = [];
    const weekCounts = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - i * 7);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 7);

      const count = allLeads.filter((l) => {
        const d = parseDate(l.submittedAt);
        return d && d >= weekStart && d < weekEnd;
      }).length;

      weeks.push(weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
      weekCounts.push(count);
    }

    if (leadsTimeChart) leadsTimeChart.destroy();
    leadsTimeChart = new Chart(document.getElementById("chart-leads-time"), {
      type: "bar",
      data: {
        labels: weeks,
        datasets: [{
          label: "Leads",
          data: weekCounts,
          backgroundColor: "rgba(59, 130, 246, 0.7)",
          borderRadius: 4,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 } },
          x: { grid: { display: false } },
        },
      },
    });

    // By loan type
    const typeCounts = {};
    allLeads.forEach((l) => {
      const type = l.loanType || "unknown";
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    });

    const typeLabels = Object.keys(typeCounts).map((k) => loanTypeLabels[k] || k);
    const typeData = Object.values(typeCounts);
    const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#6b7280"];

    if (loanTypeChart) loanTypeChart.destroy();
    loanTypeChart = new Chart(document.getElementById("chart-loan-type"), {
      type: "doughnut",
      data: {
        labels: typeLabels,
        datasets: [{
          data: typeData,
          backgroundColor: colors.slice(0, typeData.length),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { padding: 16, usePointStyle: true, pointStyle: "circle" } },
        },
      },
    });
  }

  // ===== RENDER LEADS TABLE =====
  function renderLeadsTable(leads, tableId) {
    const tbody = document.getElementById(tableId);
    const isFullTable = tableId === "all-leads-table";

    if (leads.length === 0) {
      tbody.innerHTML = "";
      if (isFullTable) document.getElementById("leads-empty").style.display = "block";
      return;
    }

    if (isFullTable) document.getElementById("leads-empty").style.display = "none";

    tbody.innerHTML = leads.map((l) => {
      const name = [l.firstName, l.lastName].filter(Boolean).join(" ") || "Unknown";
      const type = loanTypeLabels[l.loanType] || l.loanType || "--";
      const amount = loanAmountLabels[l.loanAmount] || l.loanAmount || "--";
      const status = l.status || "new";
      const date = parseDate(l.submittedAt);
      const dateStr = date ? date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "--";

      if (isFullTable) {
        return `<tr data-id="${l.id}">
          <td><strong>${esc(name)}</strong></td>
          <td>${esc(l.email || "--")}</td>
          <td>${esc(l.phone || "--")}</td>
          <td>${esc(type)}</td>
          <td>${esc(amount)}</td>
          <td>${esc(l.propertyState || "--")}</td>
          <td><span class="badge badge-${status}">${statusLabels[status] || status}</span></td>
          <td>${dateStr}</td>
        </tr>`;
      }
      return `<tr data-id="${l.id}">
        <td><strong>${esc(name)}</strong></td>
        <td>${esc(type)}</td>
        <td>${esc(amount)}</td>
        <td><span class="badge badge-${status}">${statusLabels[status] || status}</span></td>
        <td>${dateStr}</td>
      </tr>`;
    }).join("");

    // Click to open detail
    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => openLeadDetail(tr.dataset.id));
    });
  }

  function updateLeadsBadge() {
    const newCount = allLeads.filter((l) => !l.status || l.status === "new").length;
    const badge = document.getElementById("new-leads-badge");
    if (newCount > 0) {
      badge.style.display = "inline";
      badge.textContent = newCount;
    } else {
      badge.style.display = "none";
    }
  }

  function updateLeadsCount() {
    document.getElementById("leads-count").textContent = `${allLeads.length} total`;
  }

  // ===== FILTERS =====
  document.getElementById("filter-status").addEventListener("change", applyFilters);
  document.getElementById("filter-loan-type").addEventListener("change", applyFilters);
  document.getElementById("filter-search").addEventListener("input", applyFilters);

  function applyFilters() {
    const status = document.getElementById("filter-status").value;
    const loanType = document.getElementById("filter-loan-type").value;
    const search = document.getElementById("filter-search").value.toLowerCase().trim();

    let filtered = allLeads;
    if (status) filtered = filtered.filter((l) => (l.status || "new") === status);
    if (loanType) filtered = filtered.filter((l) => l.loanType === loanType);
    if (search) {
      filtered = filtered.filter((l) => {
        const name = [l.firstName, l.lastName].join(" ").toLowerCase();
        const email = (l.email || "").toLowerCase();
        return name.includes(search) || email.includes(search);
      });
    }
    renderLeadsTable(filtered, "all-leads-table");
  }

  // ===== LEAD DETAIL =====
  function openLeadDetail(id) {
    const lead = allLeads.find((l) => l.id === id);
    if (!lead) return;
    currentLeadId = id;

    const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown";
    document.getElementById("detail-name").textContent = name;
    document.getElementById("detail-fullname").textContent = name;
    document.getElementById("detail-email").textContent = lead.email || "--";
    document.getElementById("detail-phone").textContent = lead.phone || "--";
    document.getElementById("detail-loantype").textContent = loanTypeLabels[lead.loanType] || lead.loanType || "--";
    document.getElementById("detail-propertytype").textContent = lead.propertyType || "--";
    document.getElementById("detail-loanpurpose").textContent = lead.loanPurpose || "--";
    document.getElementById("detail-amount").textContent = loanAmountLabels[lead.loanAmount] || lead.loanAmount || "--";
    document.getElementById("detail-state").textContent = lead.propertyState || "--";
    document.getElementById("detail-credit").textContent = lead.creditScore || "--";
    document.getElementById("detail-timeline").textContent = timelineLabels[lead.timeline] || lead.timeline || "--";

    const date = parseDate(lead.submittedAt);
    document.getElementById("detail-date").textContent = date
      ? date.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
      : "--";

    // Lead score
    const scoreEl = document.getElementById("detail-score");
    if (typeof lead.leadScore === "number") {
      const scoreClass = lead.leadScore >= 7 ? "score-hot" : lead.leadScore >= 4 ? "score-warm" : "score-cold";
      scoreEl.innerHTML = `<span class="lead-score ${scoreClass}">${lead.leadScore}</span> / 10`;
    } else {
      scoreEl.textContent = "Not scored";
    }

    document.getElementById("detail-status").value = lead.status || "new";

    // Load emails
    loadEmails(id);

    // Open panel
    document.getElementById("detail-overlay").classList.add("open");
    document.getElementById("detail-panel").classList.add("open");
  }

  function closeDetail() {
    document.getElementById("detail-overlay").classList.remove("open");
    document.getElementById("detail-panel").classList.remove("open");
    currentLeadId = null;
  }

  document.getElementById("btn-close-detail").addEventListener("click", closeDetail);
  document.getElementById("detail-overlay").addEventListener("click", closeDetail);

  // ===== STATUS UPDATE =====
  document.getElementById("detail-status").addEventListener("change", async (e) => {
    if (!currentLeadId) return;
    const newStatus = e.target.value;
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/updateInquiryStatus`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inquiryId: currentLeadId, status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed");
      // Update local data
      const lead = allLeads.find((l) => l.id === currentLeadId);
      if (lead) lead.status = newStatus;
      renderLeadsTable(allLeads, "all-leads-table");
      renderLeadsTable(allLeads.slice(0, 5), "recent-leads-table");
      updateLeadsBadge();
      renderOverview();
      showToast("Status updated", "success");
    } catch (err) {
      console.error("Status update error:", err);
      showToast("Failed to update status", "error");
    }
  });

  // ===== EMAILS =====
  async function loadEmails(inquiryId) {
    const container = document.getElementById("detail-emails");
    try {
      const snapshot = await db.collection("inquiries").doc(inquiryId).collection("emails")
        .orderBy("sentAt", "asc").get();

      if (snapshot.empty) {
        container.innerHTML = `<div class="empty-state" style="padding:1rem"><p style="font-size:0.85rem">No emails sent yet.</p></div>`;
        return;
      }

      container.innerHTML = snapshot.docs.map((doc) => {
        const e = doc.data();
        const date = e.sentAt ? new Date(e.sentAt).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
        }) : "";
        const type = e.type === "auto-reply" ? "auto-reply" : "outbound";
        return `<div class="email-msg ${type}">
          <div class="email-msg-meta">${esc(e.from || "You")} &mdash; ${date}</div>
          <div class="email-msg-body">${esc(e.body || "")}</div>
        </div>`;
      }).join("");
    } catch (err) {
      container.innerHTML = `<div class="empty-state" style="padding:1rem"><p style="font-size:0.85rem">No emails sent yet.</p></div>`;
    }
  }

  // ===== SEND REPLY (with preview) =====
  function getSelectedSender() {
    const key = document.getElementById("reply-sender").value;
    return senderProfiles[key] || senderProfiles.zachary;
  }

  function buildPreviewHtml(body, sender, leadName) {
    const paragraphs = body.split("\n").filter(l => l.trim()).map(l => `<p>${esc(l)}</p>`).join("");
    return `
      <p>Hey ${esc(leadName)},</p>
      ${paragraphs}
      <div class="sig">
        <strong>${esc(sender.name)}</strong>
        <span>Managing Partner, Umbrella Place</span>
        <span>${esc(sender.phone)}</span>
        <span>${esc(sender.email)}</span>
      </div>
    `;
  }

  // Preview button
  document.getElementById("btn-preview").addEventListener("click", () => {
    if (!currentLeadId) return;
    const lead = allLeads.find((l) => l.id === currentLeadId);
    if (!lead || !lead.email) {
      showToast("No email address for this lead", "error");
      return;
    }
    const body = document.getElementById("reply-text").value.trim();
    if (!body) {
      showToast("Write a message first", "error");
      return;
    }
    const sender = getSelectedSender();
    const leadName = lead.firstName || "there";

    document.getElementById("preview-meta").innerHTML =
      `<strong>To:</strong> ${esc(lead.email)}<br>` +
      `<strong>From:</strong> ${esc(sender.name)} | Umbrella Place &lt;${esc(sender.email)}&gt;<br>` +
      `<strong>Subject:</strong> Following up — ${esc(sender.name)} from Umbrella Place`;
    document.getElementById("preview-body").innerHTML = buildPreviewHtml(body, sender, leadName);
    document.getElementById("preview-overlay").classList.add("open");
  });

  // Send button also shows preview first
  document.getElementById("btn-send-reply").addEventListener("click", () => {
    document.getElementById("btn-preview").click();
  });

  // Close preview
  document.getElementById("btn-close-preview").addEventListener("click", () => {
    document.getElementById("preview-overlay").classList.remove("open");
  });
  document.getElementById("btn-cancel-preview").addEventListener("click", () => {
    document.getElementById("preview-overlay").classList.remove("open");
  });

  // Confirm & send from preview
  document.getElementById("btn-confirm-send").addEventListener("click", async () => {
    if (!currentLeadId) return;
    const lead = allLeads.find((l) => l.id === currentLeadId);
    if (!lead || !lead.email) return;

    const body = document.getElementById("reply-text").value.trim();
    if (!body) return;

    const sender = getSelectedSender();
    const btn = document.getElementById("btn-confirm-send");
    btn.disabled = true;
    btn.textContent = "Sending...";

    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/sendReply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          inquiryId: currentLeadId,
          emailBody: body,
          toEmail: lead.email,
          leadName: lead.firstName || "there",
          senderKey: document.getElementById("reply-sender").value,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      document.getElementById("reply-text").value = "";
      document.getElementById("preview-overlay").classList.remove("open");
      loadEmails(currentLeadId);
      showToast("Email sent", "success");
    } catch (err) {
      console.error("Send reply error:", err);
      showToast("Failed to send email", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Confirm & Send";
    }
  });

  // ===== AI DRAFT =====
  document.getElementById("btn-ai-draft").addEventListener("click", async () => {
    if (!currentLeadId) return;
    const lead = allLeads.find((l) => l.id === currentLeadId);
    if (!lead) return;

    const btn = document.getElementById("btn-ai-draft");
    btn.disabled = true;
    btn.textContent = "Drafting...";

    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/aiDraftReply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          firstName: lead.firstName || "there",
          loanType: lead.loanType || "",
          loanAmount: lead.loanAmount || "",
          propertyState: lead.propertyState || "",
          timeline: lead.timeline || "",
          creditScore: lead.creditScore || "",
        }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      document.getElementById("reply-text").value = data.draft || "";
      showToast("AI draft ready — review before sending", "info");
    } catch (err) {
      console.error("AI draft error:", err);
      showToast("Failed to generate draft", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "AI Draft";
    }
  });

  // ===== INBOUND AGENT =====
  let leadScoreChart = null;

  function renderInboundAgent() {
    // Count auto-replies (leads with email = got an auto-reply)
    const leadsWithEmail = allLeads.filter((l) => l.email);
    document.getElementById("agent-inbound-replies").textContent = leadsWithEmail.length;

    // Chat sessions placeholder (we'll track this when chat logging is added)
    document.getElementById("agent-inbound-chats").textContent = "—";

    // Average lead score
    const scored = allLeads.filter((l) => typeof l.leadScore === "number");
    if (scored.length > 0) {
      const avg = scored.reduce((sum, l) => sum + l.leadScore, 0) / scored.length;
      document.getElementById("agent-inbound-score").textContent = avg.toFixed(1);
    } else {
      document.getElementById("agent-inbound-score").textContent = "—";
    }

    // Hot leads (score 7+)
    const hotLeads = scored.filter((l) => l.leadScore >= 7);
    document.getElementById("agent-inbound-hot").textContent = hotLeads.length;

    // Lead score distribution chart
    renderLeadScoreChart(scored);

    // Recent auto-replies log
    renderAutoReplyLog();

    // Top scored leads
    renderTopScoredLeads(scored);
  }

  function renderLeadScoreChart(scored) {
    const buckets = { "0-2": 0, "3-4": 0, "5-6": 0, "7-8": 0, "9-10": 0 };
    scored.forEach((l) => {
      const s = l.leadScore;
      if (s <= 2) buckets["0-2"]++;
      else if (s <= 4) buckets["3-4"]++;
      else if (s <= 6) buckets["5-6"]++;
      else if (s <= 8) buckets["7-8"]++;
      else buckets["9-10"]++;
    });

    if (leadScoreChart) leadScoreChart.destroy();
    const canvas = document.getElementById("chart-lead-scores");
    if (!canvas) return;

    leadScoreChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: Object.keys(buckets),
        datasets: [{
          label: "Leads",
          data: Object.values(buckets),
          backgroundColor: ["#ef4444", "#f59e0b", "#eab308", "#10b981", "#3b82f6"],
          borderRadius: 4,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 }, title: { display: true, text: "Leads" } },
          x: { title: { display: true, text: "Score Range" }, grid: { display: false } },
        },
      },
    });
  }

  function renderAutoReplyLog() {
    const tbody = document.getElementById("agent-inbound-log");
    const emptyEl = document.getElementById("agent-inbound-empty");
    const leadsWithEmail = allLeads.filter((l) => l.email).slice(0, 20);

    if (leadsWithEmail.length === 0) {
      tbody.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";

    tbody.innerHTML = leadsWithEmail.map((l) => {
      const name = [l.firstName, l.lastName].filter(Boolean).join(" ") || "Unknown";
      const type = loanTypeLabels[l.loanType] || l.loanType || "--";
      const score = typeof l.leadScore === "number" ? l.leadScore : "—";
      const scoreClass = score >= 7 ? "score-hot" : score >= 4 ? "score-warm" : "score-cold";
      const date = parseDate(l.submittedAt);
      const dateStr = date ? date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "--";

      return `<tr data-id="${l.id}">
        <td><strong>${esc(name)}</strong></td>
        <td>${esc(type)}</td>
        <td><span class="lead-score ${scoreClass}">${score}</span></td>
        <td><span class="badge badge-auto-reply">Sent</span></td>
        <td>${dateStr}</td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => openLeadDetail(tr.dataset.id));
    });
  }

  function renderTopScoredLeads(scored) {
    const tbody = document.getElementById("agent-inbound-top-leads");
    const topLeads = [...scored].sort((a, b) => b.leadScore - a.leadScore).slice(0, 10);

    if (topLeads.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:1.5rem">No scored leads yet. Scores are assigned when new inquiries come in.</td></tr>`;
      return;
    }

    tbody.innerHTML = topLeads.map((l) => {
      const name = [l.firstName, l.lastName].filter(Boolean).join(" ") || "Unknown";
      const type = loanTypeLabels[l.loanType] || l.loanType || "--";
      const amount = loanAmountLabels[l.loanAmount] || l.loanAmount || "--";
      const score = l.leadScore;
      const scoreClass = score >= 7 ? "score-hot" : score >= 4 ? "score-warm" : "score-cold";
      const status = l.status || "new";

      return `<tr data-id="${l.id}">
        <td><strong>${esc(name)}</strong></td>
        <td>${esc(l.email || "--")}</td>
        <td>${esc(type)}</td>
        <td>${esc(amount)}</td>
        <td><span class="lead-score ${scoreClass}">${score}</span></td>
        <td><span class="badge badge-${status}">${statusLabels[status] || status}</span></td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => openLeadDetail(tr.dataset.id));
    });
  }

  // ===== HELPERS =====
  function parseDate(val) {
    if (!val) return null;
    if (val.toDate) return val.toDate(); // Firestore Timestamp
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }

  function esc(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message, type) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.className = `toast ${type} visible`;
    setTimeout(() => toast.classList.remove("visible"), 3000);
  }
})();
