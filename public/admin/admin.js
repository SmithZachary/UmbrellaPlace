// Umbrella Place Admin Dashboard
(function () {
  const auth = firebase.auth();
  const db = firebase.firestore();
  const FUNCTIONS_BASE = "https://us-central1-umbrellaplace-59c7d.cloudfunctions.net";

  // Safe event binding — prevents one missing element from killing all subsequent handlers
  function on(id, event, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
    else console.warn("Missing element: #" + id);
    return el;
  }

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

  // Format dollar amounts — handles both old slugs and new raw numbers
  function fmtDollar(val) {
    if (!val) return "--";
    if (loanAmountLabels[val]) return loanAmountLabels[val];
    const num = parseInt(val, 10);
    if (!isNaN(num)) return "$" + num.toLocaleString("en-US");
    return val;
  }

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

  var dealsLoaded = false; // Deal Analyzer lazy-load flag
  var dealsLoadedAt = 0; // Timestamp of last load
  var DEALS_STALE_MS = 5 * 60 * 1000; // Re-fetch if older than 5 minutes

  // ===== PROFILE SYSTEM =====
  let activeProfile = "zachary"; // "zachary" or "cole"
  let profileVersion = 0; // incremented on profile switch to cancel stale requests
  function profileDoc(base) { return `${base}-${activeProfile}`; }

  document.querySelectorAll(".profile-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const profile = tab.dataset.profile;
      if (profile === activeProfile) return;
      activeProfile = profile;
      profileVersion++; // invalidate in-flight requests from old profile
      document.querySelectorAll(".profile-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      // Reset loaded flags so data reloads for new profile
      socialLoaded = false; scoutLoaded = false; engageLoaded = false;
      // Reload current view
      const activeView = document.querySelector(".nav-item.active");
      if (activeView) activeView.click();
    });
  });

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

    // Set default sender based on logged-in user (profile tabs are independent)
    const senderSelect = document.getElementById("reply-sender");
    if (user.email.includes("csmith")) senderSelect.value = "cole";
    else senderSelect.value = "zachary";

    // Set date
    document.getElementById("topbar-date").textContent = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });

    loadLeads();

    // One-time migration: add owner field to existing data
    if (!localStorage.getItem("profileMigrationDone")) {
      user.getIdToken().then(token => {
        fetch(`${FUNCTIONS_BASE}/migrateProfiles`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: "{}",
        }).then(r => r.json()).then(data => {
          if (data.success) {
            localStorage.setItem("profileMigrationDone", "1");
            console.log("Profile migration complete:", data.results);
          }
        }).catch(err => console.error("Migration error:", err));
      });
    }
  });

  // ===== LOGOUT =====
  on("btn-logout", "click", () => {
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
    // Flush pending saves before switching
    if (typeof flushDealSave === "function") flushDealSave();
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
      "deal-analyzer": "Deal Analyzer",
      "property-mgmt": "Property Management",
    };
    document.getElementById("topbar-title").textContent = titles[viewId] || "Dashboard";

    // Lazy-load deals (refresh if stale > 5 min)
    var needsLoad = !dealsLoaded || (Date.now() - dealsLoadedAt > DEALS_STALE_MS);
    if ((viewId === "deal-analyzer" || viewId === "property-mgmt") && needsLoad) {
      if (viewId === "property-mgmt") {
        document.getElementById("pm-loading").style.display = "flex";
        document.getElementById("pm-list-section").style.display = "none";
      }
      loadDeals().then(function() {
        dealsLoadedAt = Date.now();
        document.getElementById("pm-loading").style.display = "none";
        document.getElementById("pm-list-section").style.display = "";
        if (document.getElementById("view-property-mgmt").classList.contains("active")) {
          renderPropertyList();
        }
      });
      dealsLoaded = true;
    } else if (viewId === "property-mgmt") {
      renderPropertyList();
    }

    // Close sidebar on mobile
    document.getElementById("sidebar").classList.remove("open");
  }

  // Mobile sidebar
  on("mobile-toggle", "click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });

  // ===== LOAD LEADS =====
  async function loadLeads() {
    try {
      const snapshot = await db.collection("inquiries").orderBy("submittedAt", "desc").limit(500).get();
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
      const amount = fmtDollar(l.loanAmount);
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
          <td><button class="btn btn-secondary btn-sm lead-delete-btn" data-id="${l.id}" style="padding:0.15rem 0.4rem;font-size:0.65rem;color:#dc2626">&times;</button></td>
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

    // Click to open detail (but not on delete button)
    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".lead-delete-btn")) return;
        openLeadDetail(tr.dataset.id);
      });
    });

    // Delete buttons on full table
    if (isFullTable) {
      tbody.querySelectorAll(".lead-delete-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteLead(btn.dataset.id);
        });
      });
    }
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
  on("filter-status", "change", applyFilters);
  on("filter-loan-type", "change", applyFilters);
  on("filter-search", "input", applyFilters);

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
    document.getElementById("detail-amount").textContent = fmtDollar(lead.loanAmount);
    document.getElementById("detail-state").textContent = lead.propertyState || "--";
    document.getElementById("detail-credit").textContent = lead.creditScore || "--";
    document.getElementById("detail-timeline").textContent = timelineLabels[lead.timeline] || lead.timeline || "--";
    document.getElementById("detail-arv").textContent = fmtDollar(lead.afterRepairValue);

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

  on("btn-close-detail", "click", closeDetail);
  on("detail-overlay", "click", closeDetail);

  // Delete lead
  async function deleteLead(id) {
    if (!confirm("Delete this lead? This cannot be undone.")) return;
    try {
      await db.collection("inquiries").doc(id).delete();
      allLeads = allLeads.filter(function(l) { return l.id !== id; });
      if (currentLeadId === id) closeDetail();
      renderOverview();
      renderLeadsTable(allLeads, "all-leads-table");
      renderLeadsTable(allLeads.slice(0, 5), "recent-leads-table");
      updateLeadsBadge();
      updateLeadsCount();
      renderInboundAgent();
      showToast("Lead deleted", "success");
    } catch (err) {
      console.error("Delete lead error:", err);
      showToast("Failed to delete lead", "error");
    }
  }

  on("btn-delete-lead", "click", function() {
    if (currentLeadId) deleteLead(currentLeadId);
  });

  // ===== STATUS UPDATE =====
  on("detail-status", "change", async (e) => {
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
  on("btn-preview", "click", () => {
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
  on("btn-send-reply", "click", () => {
    document.getElementById("btn-preview").click();
  });

  // Close preview
  on("btn-close-preview", "click", () => {
    document.getElementById("preview-overlay").classList.remove("open");
  });
  on("btn-cancel-preview", "click", () => {
    document.getElementById("preview-overlay").classList.remove("open");
  });

  // Confirm & send from preview
  on("btn-confirm-send", "click", async () => {
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
  on("btn-ai-draft", "click", async () => {
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
      const amount = fmtDollar(l.loanAmount);
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

  // ===== SOCIAL MEDIA AGENT =====
  let socialPosts = [];
  let socialConfig = {};

  async function loadSocialAgent() {
    const myVersion = profileVersion;
    try {
      // Load config
      const configDoc = await db.collection("agent-config").doc(profileDoc("social")).get();
      if (profileVersion !== myVersion) return; // profile switched during load
      socialConfig = configDoc.exists ? configDoc.data() : {};

      // Populate config form
      if (socialConfig.topics) document.getElementById("social-config-topics").value = socialConfig.topics;
      if (socialConfig.tone) document.getElementById("social-config-tone").value = socialConfig.tone;
      if (socialConfig.lastRun) {
        const d = new Date(socialConfig.lastRun);
        document.getElementById("social-last-run").textContent = "Last run: " + d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      }

      // Load platform checkboxes (batch run platforms)
      if (socialConfig.platforms) {
        document.querySelectorAll("#social-config-panel .checkbox-row:first-of-type input[type=checkbox]").forEach(cb => {
          cb.checked = socialConfig.platforms.includes(cb.value);
        });
      }

      // Load schedule config
      if (socialConfig.scheduleEnabled !== undefined) {
        document.getElementById("social-schedule-enabled").checked = socialConfig.scheduleEnabled;
      }
      if (socialConfig.schedulePlatforms) {
        document.querySelectorAll("#schedule-platforms input[type=checkbox]").forEach(cb => {
          cb.checked = socialConfig.schedulePlatforms.includes(cb.value);
        });
      }

      // Load posts
      const snap = await db.collection("social-posts").where("owner", "==", activeProfile).orderBy("generatedAt", "desc").limit(50).get();
      socialPosts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderSocialStats();
      renderSocialTable();
      renderSocialCalendar();
    } catch (err) {
      console.error("Load social agent error:", err);
    }
  }

  // ===== SOCIAL CALENDAR =====
  let calendarDate = new Date();

  function renderSocialCalendar() {
    const container = document.getElementById("social-calendar");
    if (!container) return;

    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();

    // Update month label
    const label = document.getElementById("cal-month-label");
    if (label) label.textContent = new Date(year, month).toLocaleString("en-US", { month: "long", year: "numeric" });

    // Build day headers
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let html = days.map(d => `<div class="cal-header">${d}</div>`).join("");

    // First day of month and total days
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev = new Date(year, month, 0).getDate();

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;

    // Index posts by date
    const postsByDate = {};
    socialPosts.forEach(p => {
      const dateStr = (p.postedAt || p.generatedAt || "").slice(0, 10);
      if (!dateStr) return;
      if (!postsByDate[dateStr]) postsByDate[dateStr] = [];
      postsByDate[dateStr].push(p);
    });

    // Previous month trailing days
    for (let i = firstDay - 1; i >= 0; i--) {
      const day = daysInPrev - i;
      const m = month === 0 ? 12 : month;
      const y = month === 0 ? year - 1 : year;
      const dateStr = `${y}-${String(m).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      html += renderCalDay(day, dateStr, "other-month", postsByDate[dateStr], todayStr);
    }

    // Current month days
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const cls = dateStr === todayStr ? "today" : "";
      html += renderCalDay(day, dateStr, cls, postsByDate[dateStr], todayStr);
    }

    // Next month leading days
    const totalCells = firstDay + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let day = 1; day <= remaining; day++) {
      const m = month + 2 > 12 ? 1 : month + 2;
      const y = month + 2 > 12 ? year + 1 : year;
      const dateStr = `${y}-${String(m).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      html += renderCalDay(day, dateStr, "other-month", postsByDate[dateStr], todayStr);
    }

    container.innerHTML = html;

    // Tooltip hover events
    let tooltip = null;
    container.querySelectorAll(".cal-post").forEach(el => {
      el.addEventListener("mouseenter", (e) => {
        const postId = el.dataset.postId;
        const post = socialPosts.find(p => p.id === postId);
        if (!post) return;
        tooltip = document.createElement("div");
        tooltip.className = "cal-tooltip";
        tooltip.innerHTML = `
          <div class="cal-tooltip-platform">${capitalize(post.platform)}</div>
          <div class="cal-tooltip-status">${capitalize(post.status)} &middot; ${post.postedAt || post.generatedAt ? new Date(post.postedAt || post.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</div>
          <div class="cal-tooltip-content">${esc((post.content || "").slice(0, 200))}${(post.content || "").length > 200 ? "..." : ""}</div>
        `;
        document.body.appendChild(tooltip);
        positionTooltip(e, tooltip);
      });
      el.addEventListener("mousemove", (e) => { if (tooltip) positionTooltip(e, tooltip); });
      el.addEventListener("mouseleave", () => { if (tooltip) { tooltip.remove(); tooltip = null; } });
    });
  }

  function renderCalDay(day, dateStr, extraCls, posts, todayStr) {
    let html = `<div class="cal-day ${extraCls}"><div class="cal-day-num">${day}</div>`;
    if (posts && posts.length > 0) {
      const show = posts.slice(0, 3);
      show.forEach(p => {
        const statusCls = p.status === "posted" ? "posted" : (p.status || "draft");
        const icon = p.status === "posted" ? "&#10003; " : p.status === "queued" ? "&#9202; " : "";
        html += `<div class="cal-post cal-post-${p.platform} ${statusCls}" data-post-id="${p.id}" title="${capitalize(p.platform)}">${icon}${esc((p.topic || p.content || "").slice(0, 25))}</div>`;
      });
      if (posts.length > 3) {
        html += `<div class="cal-more">+${posts.length - 3} more</div>`;
      }
    }

    // Show schedule dots for future days (9 AM and 3 PM)
    if (dateStr > todayStr) {
      const dayOfWeek = new Date(dateStr).getDay();
      if (dayOfWeek > 0 && dayOfWeek < 6 && (!posts || posts.length === 0)) {
        html += `<div class="cal-schedule-row"><div class="cal-schedule-dot future" title="9 AM scheduled"></div><div class="cal-schedule-dot future" title="3 PM scheduled"></div></div>`;
      }
    }

    html += `</div>`;
    return html;
  }

  function positionTooltip(e, tip) {
    let x = e.clientX + 12;
    let y = e.clientY + 12;
    if (x + 310 > window.innerWidth) x = e.clientX - 310;
    if (y + 150 > window.innerHeight) y = e.clientY - 150;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  // Calendar nav
  document.getElementById("cal-prev")?.addEventListener("click", () => {
    calendarDate.setMonth(calendarDate.getMonth() - 1);
    renderSocialCalendar();
  });
  document.getElementById("cal-next")?.addEventListener("click", () => {
    calendarDate.setMonth(calendarDate.getMonth() + 1);
    renderSocialCalendar();
  });

  function renderSocialStats() {
    document.getElementById("social-stat-total").textContent = socialPosts.length;
    document.getElementById("social-stat-published").textContent = socialPosts.filter(p => p.status === "posted").length;
    document.getElementById("social-stat-drafts").textContent = socialPosts.filter(p => p.status === "draft" || p.status === "queued").length;

    // Top platform
    const platCounts = {};
    socialPosts.forEach(p => { platCounts[p.platform] = (platCounts[p.platform] || 0) + 1; });
    const topPlat = Object.entries(platCounts).sort((a, b) => b[1] - a[1])[0];
    document.getElementById("social-stat-platform").textContent = topPlat ? capitalize(topPlat[0]) : "--";
  }

  function renderSocialTable() {
    const tbody = document.getElementById("social-posts-table");
    const empty = document.getElementById("social-posts-empty");
    const filterPlat = document.getElementById("social-filter-platform").value;
    const filterStatus = document.getElementById("social-filter-status").value;

    let filtered = socialPosts;
    if (filterPlat) filtered = filtered.filter(p => p.platform === filterPlat);
    if (filterStatus) filtered = filtered.filter(p => p.status === filterStatus);

    if (filtered.length === 0) {
      tbody.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    tbody.innerHTML = filtered.map(p => {
      const date = p.generatedAt ? new Date(p.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "--";
      const preview = (p.content || "").slice(0, 80) + ((p.content || "").length > 80 ? "..." : "");
      const statusClass = p.status === "posted" ? "badge-closed-won" : p.status === "queued" ? "badge-in-progress" : "badge-new";
      return `<tr data-id="${p.id}">
        <td><span class="badge badge-platform-${p.platform}">${capitalize(p.platform)}</span></td>
        <td>${esc(p.topic || "--")}</td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(preview)}</td>
        <td><span class="badge ${statusClass}">${capitalize(p.status)}</span></td>
        <td>${date}</td>
        <td>
          <button class="btn btn-secondary btn-sm btn-copy-row" data-id="${p.id}" title="Copy">Copy</button>
          ${p.platform === "x" && p.status !== "posted" ? `<button class="btn btn-sm btn-post-x" data-id="${p.id}" style="background:#000;color:#fff;border:none;margin-left:4px" title="Post to X">Post to X</button>` : ""}
          ${p.platform === "facebook" && p.status !== "posted" ? `<button class="btn btn-sm btn-post-fb" data-id="${p.id}" style="background:#1877F2;color:#fff;border:none;margin-left:4px" title="Post to Facebook">Post to FB</button>` : ""}
          ${p.status !== "posted" ? `<button class="btn btn-sm btn-delete-post" data-id="${p.id}" style="background:var(--danger);color:#fff;border:none;margin-left:4px" title="Delete">Delete</button>` : ""}
        </td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll(".btn-copy-row").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = socialPosts.find(p => p.id === btn.dataset.id);
        if (row) navigator.clipboard.writeText(row.content).then(() => showToast("Copied to clipboard", "success"));
      });
    });

    tbody.querySelectorAll(".btn-post-x").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const post = socialPosts.find(p => p.id === id);
        if (!post) return;
        btn.disabled = true;
        btn.textContent = "Posting...";
        try {
          const token = await currentUser.getIdToken();
          const resp = await fetch(`${FUNCTIONS_BASE}/postToX`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ postId: id, content: post.content }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || "Failed to post");
          post.status = "posted";
          post.xTweetId = data.tweetId;
          renderSocialStats();
          renderSocialTable();
          showToast("Posted to X successfully!", "success");
        } catch (err) {
          showToast("Failed to post to X: " + err.message, "error");
          btn.disabled = false;
          btn.textContent = "Post to X";
        }
      });
    });

    tbody.querySelectorAll(".btn-post-fb").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const post = socialPosts.find(p => p.id === id);
        if (!post) return;
        btn.disabled = true;
        btn.textContent = "Posting...";
        try {
          const token = await currentUser.getIdToken();
          const resp = await fetch(`${FUNCTIONS_BASE}/postToFacebook`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ postId: id, content: post.content }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || "Failed to post");
          post.status = "posted";
          post.fbPostId = data.fbPostId;
          renderSocialStats();
          renderSocialTable();
          showToast("Posted to Facebook successfully!", "success");
        } catch (err) {
          showToast("Failed to post to Facebook: " + err.message, "error");
          btn.disabled = false;
          btn.textContent = "Post to FB";
        }
      });
    });

    tbody.querySelectorAll(".btn-delete-post").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this post?")) return;
        const id = btn.dataset.id;
        await db.collection("social-posts").doc(id).delete();
        socialPosts = socialPosts.filter(p => p.id !== id);
        renderSocialStats();
        renderSocialTable();
        showToast("Post deleted", "success");
      });
    });
  }

  // Social config toggle
  on("social-config-toggle", "click", () => {
    const panel = document.getElementById("social-config-panel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  // Save social config
  on("btn-save-social-config", "click", async () => {
    const platforms = [];
    document.querySelectorAll("#social-config-panel .checkbox-row:first-of-type input:checked").forEach(cb => platforms.push(cb.value));
    const schedulePlatforms = [];
    document.querySelectorAll("#schedule-platforms input:checked").forEach(cb => schedulePlatforms.push(cb.value));
    const config = {
      platforms,
      schedulePlatforms,
      scheduleEnabled: document.getElementById("social-schedule-enabled").checked,
      topics: document.getElementById("social-config-topics").value.trim(),
      tone: document.getElementById("social-config-tone").value.trim(),
    };
    try {
      const token = await currentUser.getIdToken();
      await fetch(`${FUNCTIONS_BASE}/saveAgentConfig`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent: "social", config, profile: activeProfile }),
      });
      socialConfig = { ...socialConfig, ...config };
      showToast("Social config saved", "success");
    } catch (err) {
      showToast("Failed to save config", "error");
    }
  });

  // Run social agent
  on("btn-run-social", "click", async () => {
    const btn = document.getElementById("btn-run-social");
    btn.disabled = true;
    btn.textContent = "Running...";
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/runSocialAgent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile: activeProfile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");

      // Build detailed summary
      const summary = (data.results || []).map(r => {
        if (r.error) return `${capitalize(r.platform)}: Failed`;
        return `${capitalize(r.platform)}: ${r.posted ? "Posted!" : "Queued"} — "${(r.topic || "").slice(0, 40)}..."`;
      }).join("\n");

      const xPosted = (data.results || []).find(r => r.platform === "x" && r.posted);
      const toastMsg = `Generated ${data.generated} posts` + (xPosted ? " — X auto-posted!" : "");
      showToast(toastMsg, "success");

      // Show run results summary
      const outputEl = document.getElementById("social-output");
      const textEl = document.getElementById("social-output-text");
      textEl.value = `Run complete — ${data.generated} posts generated:\n\n${summary}`;
      outputEl.style.display = "block";

      await loadSocialAgent();

      // Scroll to Content Library
      document.getElementById("social-posts-table")?.closest(".card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      showToast(err.message || "Failed to run social agent", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Run Agent";
    }
  });

  // Quick generate single post
  on("btn-generate-post", "click", async () => {
    const platform = document.getElementById("social-platform").value;
    const topic = document.getElementById("social-topic").value.trim();
    const tone = document.getElementById("social-tone").value;
    if (!topic) { showToast("Enter a topic", "error"); return; }

    const btn = document.getElementById("btn-generate-post");
    btn.disabled = true;
    btn.textContent = "Generating...";
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/generateSocialPost`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ platform, topic, tone, profile: activeProfile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      document.getElementById("social-output-text").value = data.content;
      document.getElementById("social-output").style.display = "block";
      showToast("Post generated", "success");
      loadSocialAgent();
    } catch (err) {
      showToast("Failed to generate post", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate Post";
    }
  });

  on("btn-copy-post", "click", () => {
    navigator.clipboard.writeText(document.getElementById("social-output-text").value);
    showToast("Copied to clipboard", "success");
  });

  on("btn-regenerate-post", "click", () => {
    document.getElementById("btn-generate-post").click();
  });

  on("btn-save-post", "click", async () => {
    const content = document.getElementById("social-output-text").value;
    if (!content) return;
    await db.collection("social-posts").add({
      platform: document.getElementById("social-platform").value,
      topic: document.getElementById("social-topic").value,
      tone: document.getElementById("social-tone").value,
      content, status: "draft", owner: activeProfile,
      generatedAt: new Date().toISOString(), generatedBy: "manual",
    });
    showToast("Saved as draft", "success");
    loadSocialAgent();
  });

  // Social filters
  on("social-filter-platform", "change", renderSocialTable);
  on("social-filter-status", "change", renderSocialTable);

  // ===== WEB SCOUT AGENT =====
  let scoutOpps = [];
  let scoutConfig = {};
  let lastAnalysis = null;
  let lastAnalysisOppId = null;

  async function loadScoutAgent() {
    const myVersion = profileVersion;
    try {
      const configDoc = await db.collection("agent-config").doc(profileDoc("scout")).get();
      if (profileVersion !== myVersion) return; // profile switched during load
      scoutConfig = configDoc.exists ? configDoc.data() : {};

      if (scoutConfig.keywords) document.getElementById("scout-config-keywords").value = scoutConfig.keywords;
      if (scoutConfig.subreddits) document.getElementById("scout-config-subreddits").value = scoutConfig.subreddits;
      if (scoutConfig.minScore) document.getElementById("scout-config-minscore").value = scoutConfig.minScore;
      if (scoutConfig.period) document.getElementById("scout-config-period").value = scoutConfig.period;
      if (scoutConfig.scheduleEnabled !== undefined) {
        document.getElementById("scout-schedule-enabled").checked = scoutConfig.scheduleEnabled;
      }
      if (scoutConfig.autoEngage !== undefined) {
        document.getElementById("scout-auto-engage").checked = scoutConfig.autoEngage;
      }
      if (scoutConfig.emailAlerts !== undefined) {
        document.getElementById("scout-email-alerts").checked = scoutConfig.emailAlerts;
      }
      if (scoutConfig.lastRun) {
        const d = new Date(scoutConfig.lastRun);
        document.getElementById("scout-last-run").textContent = "Last run: " + d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      }

      const snap = await db.collection("scout-opportunities").where("owner", "==", activeProfile).orderBy("discoveredAt", "desc").limit(50).get();
      scoutOpps = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderScoutStats();
      renderScoutTable();
    } catch (err) {
      console.error("Load scout agent error:", err);
    }
  }

  function renderScoutStats() {
    document.getElementById("scout-stat-total").textContent = scoutOpps.length;
    document.getElementById("scout-stat-high").textContent = scoutOpps.filter(o => o.score >= 7).length;
    document.getElementById("scout-stat-engaged").textContent = scoutOpps.filter(o => o.status === "engaged").length;
    const scored = scoutOpps.filter(o => typeof o.score === "number" && o.score > 0);
    document.getElementById("scout-stat-avg").textContent = scored.length > 0
      ? (scored.reduce((s, o) => s + o.score, 0) / scored.length).toFixed(1) : "--";
  }

  function renderScoutTable() {
    const tbody = document.getElementById("scout-opps-table");
    const empty = document.getElementById("scout-opps-empty");
    const filterStatus = document.getElementById("scout-filter-status").value;

    let filtered = scoutOpps;
    if (filterStatus) filtered = filtered.filter(o => o.status === filterStatus);

    if (filtered.length === 0) {
      tbody.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    tbody.innerHTML = filtered.map(o => {
      let analysis = o.analysis || {};
      if (typeof analysis === "string") {
        try { analysis = JSON.parse(analysis.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()); } catch { analysis = { summary: analysis }; }
      }
      const summary = analysis.summary || (o.title || "").slice(0, 60) || "--";
      const scoreClass = o.score >= 7 ? "score-hot" : o.score >= 4 ? "score-warm" : "score-cold";
      const statusClass = o.status === "engaged" ? "badge-closed-won" : o.status === "dismissed" ? "badge-closed-lost" : "badge-new";
      const date = o.discoveredAt ? new Date(o.discoveredAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "--";
      const sourceLabel = o.subreddit ? `r/${o.subreddit}` : capitalize(o.source || "manual");
      return `<tr data-id="${o.id}" style="cursor:pointer">
        <td>${esc(sourceLabel)}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(summary)}</td>
        <td>${esc(analysis.loanType || "--")}</td>
        <td><span class="lead-score ${scoreClass}">${o.score || 0}</span></td>
        <td><span class="badge ${statusClass}">${capitalize(o.status || "new")}</span></td>
        <td>${date}</td>
        <td>
          ${o.url ? `<a href="${esc(o.url)}" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none" onclick="event.stopPropagation()">Source</a>` : ""}
          <button class="btn btn-sm btn-view-opp" data-id="${o.id}" style="background:var(--accent);color:#fff;border:none;margin-left:4px">Details</button>
        </td>
      </tr>`;
    }).join("");

    // Click row to open detail
    tbody.querySelectorAll("tr").forEach(tr => {
      tr.addEventListener("click", () => openScoutDetail(tr.dataset.id));
    });
    tbody.querySelectorAll(".btn-view-opp").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openScoutDetail(btn.dataset.id);
      });
    });
  }

  // ===== SCOUT DETAIL PANEL =====
  let currentScoutOppId = null;

  function openScoutDetail(id) {
    const opp = scoutOpps.find(o => o.id === id);
    if (!opp) return;
    currentScoutOppId = id;
    let analysis = opp.analysis || {};
    // If analysis is a string (raw JSON that wasn't parsed), try to parse it
    if (typeof analysis === "string") {
      try {
        analysis = JSON.parse(analysis.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
      } catch { analysis = { summary: analysis }; }
    }

    // Title
    document.getElementById("scout-detail-title").textContent = opp.title || "Opportunity Details";

    // Score
    const scoreEl = document.getElementById("scout-detail-score");
    scoreEl.textContent = opp.score || 0;
    scoreEl.className = `lead-score ${opp.score >= 7 ? "score-hot" : opp.score >= 4 ? "score-warm" : "score-cold"}`;

    // Loan type, source, status
    document.getElementById("scout-detail-loantype").textContent = analysis.loanType || "--";
    document.getElementById("scout-detail-source").textContent = opp.subreddit ? `r/${opp.subreddit}` : capitalize(opp.source || "unknown");
    const statusEl = document.getElementById("scout-detail-status");
    const statusClass = opp.status === "engaged" ? "badge-closed-won" : opp.status === "dismissed" ? "badge-closed-lost" : "badge-new";
    statusEl.className = `badge ${statusClass}`;
    statusEl.textContent = capitalize(opp.status || "new");

    // Summary, approach
    document.getElementById("scout-detail-summary").textContent = analysis.summary || "--";
    document.getElementById("scout-detail-approach").textContent = analysis.approach || "--";

    // Signals
    document.getElementById("scout-detail-signals").innerHTML = (analysis.signals || [])
      .map(s => `<span class="signal-tag">${esc(s)}</span>`).join("") || '<span style="color:var(--text-muted)">None</span>';

    // Original post
    document.getElementById("scout-detail-post").textContent = opp.description || opp.title || "--";

    // Source link — always show, construct fallback if no direct URL
    const linkEl = document.getElementById("scout-detail-link");
    const sourceUrl = opp.url
      || (opp.subreddit ? `https://www.reddit.com/r/${opp.subreddit}/` : "")
      || (opp.source === "biggerpockets" ? "https://www.biggerpockets.com/forums" : "");
    if (sourceUrl) {
      linkEl.href = sourceUrl;
      linkEl.style.display = "inline-block";
    } else {
      linkEl.style.display = "none";
    }

    // Check for existing engagement draft
    loadScoutDraft(id);

    // Open panel
    document.getElementById("scout-detail-overlay").classList.add("open");
    document.getElementById("scout-detail-panel").classList.add("open");
  }

  async function loadScoutDraft(oppId) {
    const draftSection = document.getElementById("scout-detail-draft-section");
    try {
      const snap = await db.collection("engagement-drafts")
        .where("opportunityId", "==", oppId)
        .limit(1)
        .get();
      if (!snap.empty) {
        const draft = snap.docs[0].data();
        document.getElementById("scout-detail-draft").value = draft.draft || "";
        draftSection.style.display = "block";
      } else {
        draftSection.style.display = "none";
      }
    } catch {
      draftSection.style.display = "none";
    }
  }

  function closeScoutDetail() {
    document.getElementById("scout-detail-overlay").classList.remove("open");
    document.getElementById("scout-detail-panel").classList.remove("open");
    currentScoutOppId = null;
  }

  on("btn-close-scout-detail", "click", closeScoutDetail);
  on("scout-detail-overlay", "click", closeScoutDetail);

  // Detail panel actions
  on("btn-scout-detail-engage", "click", async () => {
    if (!currentScoutOppId) return;
    const opp = scoutOpps.find(o => o.id === currentScoutOppId);
    if (!opp) return;

    const btn = document.getElementById("btn-scout-detail-engage");
    btn.disabled = true;
    btn.textContent = "Drafting...";
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/draftEngagement`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          platform: opp.source || "reddit",
          context: opp.description || opp.title || "",
          opportunityId: currentScoutOppId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");

      document.getElementById("scout-detail-draft").value = data.draft;
      document.getElementById("scout-detail-draft-section").style.display = "block";

      // Update status
      opp.status = "engaged";
      const statusEl = document.getElementById("scout-detail-status");
      statusEl.className = "badge badge-closed-won";
      statusEl.textContent = "Engaged";
      renderScoutStats();
      renderScoutTable();
      showToast("Engagement draft created", "success");
    } catch (err) {
      showToast("Failed to draft engagement", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Draft Engagement";
    }
  });

  on("btn-scout-detail-dismiss", "click", async () => {
    if (!currentScoutOppId) return;
    await db.collection("scout-opportunities").doc(currentScoutOppId).update({ status: "dismissed" });
    const opp = scoutOpps.find(o => o.id === currentScoutOppId);
    if (opp) opp.status = "dismissed";
    closeScoutDetail();
    renderScoutStats();
    renderScoutTable();
    showToast("Opportunity dismissed", "info");
  });

  on("btn-scout-copy-draft", "click", () => {
    navigator.clipboard.writeText(document.getElementById("scout-detail-draft").value);
    showToast("Draft copied to clipboard", "success");
  });

  on("btn-scout-redraft", "click", () => {
    document.getElementById("btn-scout-detail-engage").click();
  });

  document.getElementById("btn-scout-engage-detail")?.addEventListener("click", () => {
    // Open the source URL and copy the draft for easy pasting
    const opp = scoutOpps.find(o => o.id === currentScoutOppId);
    if (opp && opp.url) {
      navigator.clipboard.writeText(document.getElementById("scout-detail-draft").value);
      window.open(opp.url, "_blank");
      showToast("Draft copied — paste it on the source post", "success");
    }
  });

  // Scout config toggle
  on("scout-config-toggle", "click", () => {
    const panel = document.getElementById("scout-config-panel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  // Save scout config
  on("btn-save-scout-config", "click", async () => {
    const config = {
      keywords: document.getElementById("scout-config-keywords").value.trim(),
      subreddits: document.getElementById("scout-config-subreddits").value.trim(),
      minScore: document.getElementById("scout-config-minscore").value,
      period: document.getElementById("scout-config-period").value,
      scheduleEnabled: document.getElementById("scout-schedule-enabled").checked,
      autoEngage: document.getElementById("scout-auto-engage").checked,
      emailAlerts: document.getElementById("scout-email-alerts").checked,
    };
    try {
      const token = await currentUser.getIdToken();
      await fetch(`${FUNCTIONS_BASE}/saveAgentConfig`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent: "scout", config, profile: activeProfile }),
      });
      scoutConfig = { ...scoutConfig, ...config };
      showToast("Scout config saved", "success");
    } catch (err) {
      showToast("Failed to save config", "error");
    }
  });

  // Run scout agent
  on("btn-run-scout", "click", async () => {
    const btn = document.getElementById("btn-run-scout");
    btn.disabled = true;
    btn.textContent = "Scanning...";
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/runScoutAgent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile: activeProfile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      showToast(`Scanned ${data.scanned} combos, found ${data.found} opportunities`, "success");
      loadScoutAgent();
    } catch (err) {
      showToast(err.message || "Failed to run scout", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Run Scan";
    }
  });

  // Manual analyze
  on("btn-analyze-opp", "click", async () => {
    const source = document.getElementById("scout-source").value;
    const url = document.getElementById("scout-url").value.trim();
    const description = document.getElementById("scout-description").value.trim();
    if (!url) { showToast("Paste the post URL so we can link back to it", "error"); return; }
    if (!description) { showToast("Paste the post content", "error"); return; }

    const btn = document.getElementById("btn-analyze-opp");
    btn.disabled = true;
    btn.textContent = "Analyzing...";
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/analyzeOpportunity`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, url, description, profile: activeProfile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");

      lastAnalysis = data.analysis;
      lastAnalysisOppId = data.opportunityId;

      const scoreClass = data.analysis.score >= 7 ? "score-hot" : data.analysis.score >= 4 ? "score-warm" : "score-cold";
      document.getElementById("scout-output-score").className = `lead-score ${scoreClass}`;
      document.getElementById("scout-output-score").textContent = data.analysis.score;
      document.getElementById("scout-output-type").textContent = data.analysis.loanType || "--";
      document.getElementById("scout-output-summary").textContent = data.analysis.summary || "--";
      document.getElementById("scout-output-approach").textContent = data.analysis.approach || "--";
      document.getElementById("scout-output-signals").innerHTML = (data.analysis.signals || [])
        .map(s => `<span class="signal-tag">${esc(s)}</span>`).join("");
      document.getElementById("scout-output").style.display = "block";

      showToast("Analysis complete", "success");
      loadScoutAgent();
    } catch (err) {
      showToast("Failed to analyze", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Analyze";
    }
  });

  // Engage from scout output
  on("btn-engage-opp", "click", () => {
    const desc = document.getElementById("scout-description").value;
    switchView("agent-engage");
    document.getElementById("engage-platform").value = document.getElementById("scout-source").value;
    document.getElementById("engage-context").value = desc;
  });

  // Dismiss from scout output
  on("btn-dismiss-opp", "click", async () => {
    if (lastAnalysisOppId) {
      await db.collection("scout-opportunities").doc(lastAnalysisOppId).update({ status: "dismissed" });
      document.getElementById("scout-output").style.display = "none";
      showToast("Opportunity dismissed", "info");
      loadScoutAgent();
    }
  });

  // Scout filter
  on("scout-filter-status", "change", renderScoutTable);

  // ===== ENGAGEMENT AGENT =====
  let engageDrafts = [];
  let engageConfig = {};
  let currentDraftId = null;

  async function loadEngagementAgent() {
    const myVersion = profileVersion;
    try {
      const configDoc = await db.collection("agent-config").doc(profileDoc("engagement")).get();
      if (profileVersion !== myVersion) return; // profile switched during load
      engageConfig = configDoc.exists ? configDoc.data() : {};

      if (engageConfig.minScore) document.getElementById("engage-config-minscore").value = engageConfig.minScore;
      if (engageConfig.tone) document.getElementById("engage-config-tone").value = engageConfig.tone;
      if (engageConfig.lastRun) {
        const d = new Date(engageConfig.lastRun);
        document.getElementById("engage-last-run").textContent = "Last run: " + d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      }

      const snap = await db.collection("engagement-drafts").where("owner", "==", activeProfile).orderBy("createdAt", "desc").limit(50).get();
      engageDrafts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderEngageStats();
      renderEngageTable();
    } catch (err) {
      console.error("Load engagement agent error:", err);
    }
  }

  function renderEngageStats() {
    document.getElementById("engage-stat-drafts").textContent = engageDrafts.length;
    document.getElementById("engage-stat-approved").textContent = engageDrafts.filter(d => d.status === "approved").length;
    document.getElementById("engage-stat-sent").textContent = engageDrafts.filter(d => d.status === "sent").length;
    document.getElementById("engage-stat-pending").textContent = engageDrafts.filter(d => d.status === "pending").length;
  }

  function renderEngageTable() {
    const tbody = document.getElementById("engage-history-table");
    const empty = document.getElementById("engage-history-empty");
    const filterStatus = document.getElementById("engage-filter-status").value;

    let filtered = engageDrafts;
    if (filterStatus) filtered = filtered.filter(d => d.status === filterStatus);

    if (filtered.length === 0) {
      tbody.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    tbody.innerHTML = filtered.map(d => {
      const contextPreview = (d.context || "").slice(0, 60) + ((d.context || "").length > 60 ? "..." : "");
      const draftPreview = (d.draft || "").slice(0, 60) + ((d.draft || "").length > 60 ? "..." : "");
      const statusClass = d.status === "sent" ? "badge-closed-won" : d.status === "approved" ? "badge-in-progress" : "badge-new";
      const date = d.createdAt ? new Date(d.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "--";
      return `<tr data-id="${d.id}">
        <td><span class="badge badge-platform-${d.platform}">${capitalize(d.platform || "other")}</span></td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(contextPreview)}</td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(draftPreview)}</td>
        <td><span class="badge ${statusClass}">${capitalize(d.status || "pending")}</span></td>
        <td>${date}</td>
        <td>
          <button class="btn btn-secondary btn-sm btn-view-draft" data-id="${d.id}">View</button>
          ${d.status === "pending" ? `<button class="btn btn-sm btn-approve-row" data-id="${d.id}" style="background:var(--accent);color:#fff;border:none;margin-left:4px">Approve</button>` : ""}
          ${d.status === "approved" ? `<button class="btn btn-sm btn-sent-row" data-id="${d.id}" style="background:var(--success);color:#fff;border:none;margin-left:4px">Sent</button>` : ""}
        </td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll(".btn-view-draft").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const draft = engageDrafts.find(d => d.id === btn.dataset.id);
        if (draft) {
          document.getElementById("engage-platform").value = draft.platform || "other";
          document.getElementById("engage-context").value = draft.context || "";
          document.getElementById("engage-output-text").value = draft.draft || "";
          document.getElementById("engage-output").style.display = "block";
          currentDraftId = draft.id;
        }
      });
    });

    tbody.querySelectorAll(".btn-approve-row").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await db.collection("engagement-drafts").doc(btn.dataset.id).update({ status: "approved" });
        const d = engageDrafts.find(x => x.id === btn.dataset.id);
        if (d) d.status = "approved";
        renderEngageStats();
        renderEngageTable();
        showToast("Approved", "success");
      });
    });

    tbody.querySelectorAll(".btn-sent-row").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await db.collection("engagement-drafts").doc(btn.dataset.id).update({ status: "sent", sentAt: new Date().toISOString() });
        const d = engageDrafts.find(x => x.id === btn.dataset.id);
        if (d) d.status = "sent";
        renderEngageStats();
        renderEngageTable();
        showToast("Marked as sent", "success");
      });
    });
  }

  // Engage config toggle
  on("engage-config-toggle", "click", () => {
    const panel = document.getElementById("engage-config-panel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  // Save engage config
  on("btn-save-engage-config", "click", async () => {
    const config = {
      minScore: document.getElementById("engage-config-minscore").value,
      tone: document.getElementById("engage-config-tone").value.trim(),
    };
    try {
      const token = await currentUser.getIdToken();
      await fetch(`${FUNCTIONS_BASE}/saveAgentConfig`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent: "engagement", config, profile: activeProfile }),
      });
      engageConfig = { ...engageConfig, ...config };
      showToast("Engagement config saved", "success");
    } catch (err) {
      showToast("Failed to save config", "error");
    }
  });

  // Run engagement agent
  on("btn-run-engage", "click", async () => {
    const btn = document.getElementById("btn-run-engage");
    btn.disabled = true;
    btn.textContent = "Running...";
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/runEngagementAgent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile: activeProfile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      showToast(data.drafted > 0 ? `Drafted ${data.drafted} responses` : "No new opportunities to engage with", data.drafted > 0 ? "success" : "info");
      loadEngagementAgent();
    } catch (err) {
      showToast(err.message || "Failed to run engagement agent", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Run Agent";
    }
  });

  // Quick draft
  on("btn-draft-engage", "click", async () => {
    const platform = document.getElementById("engage-platform").value;
    const context = document.getElementById("engage-context").value.trim();
    if (!context) { showToast("Paste the conversation context", "error"); return; }

    const btn = document.getElementById("btn-draft-engage");
    btn.disabled = true;
    btn.textContent = "Drafting...";
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/draftEngagement`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ platform, context, opportunityId: lastAnalysisOppId || "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      document.getElementById("engage-output-text").value = data.draft;
      document.getElementById("engage-output").style.display = "block";
      currentDraftId = data.draftId;
      showToast("Draft ready", "success");
      loadEngagementAgent();
    } catch (err) {
      showToast("Failed to generate draft", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate Draft";
    }
  });

  on("btn-copy-engage", "click", () => {
    navigator.clipboard.writeText(document.getElementById("engage-output-text").value);
    showToast("Copied to clipboard", "success");
  });

  on("btn-redraft-engage", "click", () => {
    document.getElementById("btn-draft-engage").click();
  });

  on("btn-approve-engage", "click", async () => {
    if (currentDraftId) {
      await db.collection("engagement-drafts").doc(currentDraftId).update({ status: "approved", draft: document.getElementById("engage-output-text").value });
      showToast("Draft approved", "success");
      loadEngagementAgent();
    }
  });

  on("btn-mark-sent-engage", "click", async () => {
    if (currentDraftId) {
      await db.collection("engagement-drafts").doc(currentDraftId).update({ status: "sent", sentAt: new Date().toISOString(), draft: document.getElementById("engage-output-text").value });
      showToast("Marked as sent", "success");
      document.getElementById("engage-output").style.display = "none";
      loadEngagementAgent();
    }
  });

  // Engage filter
  on("engage-filter-status", "change", renderEngageTable);

  // ===== LAZY LOAD AGENTS ON VIEW SWITCH =====
  let socialLoaded = false, scoutLoaded = false, engageLoaded = false;

  const origSwitchView = switchView;
  switchView = function(viewId) {
    origSwitchView(viewId);
    if (viewId === "agent-social" && !socialLoaded) { socialLoaded = true; loadSocialAgent(); }
    if (viewId === "agent-scout" && !scoutLoaded) { scoutLoaded = true; loadScoutAgent(); }
    if (viewId === "agent-engage" && !engageLoaded) { engageLoaded = true; loadEngagementAgent(); }
  };

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

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
  var escHtml = esc;

  function showToast(message, type) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.className = `toast ${type} visible`;
    setTimeout(() => toast.classList.remove("visible"), 3000);
  }

  // ===== DEAL ANALYZER =====
  var allDeals = [];
  var currentDealId = null;
  var currentPhase = "phase1";

  const CHECKLIST_LABELS = {
    phase1: {
      marketMatch: "Property matches target market/area",
      priceInRange: "Price within buy box range",
      arvVerified: "ARV verified with 3+ comps",
      rentVerified: "Rental rates verified (if applicable)",
      neighborhoodResearched: "Neighborhood & school district researched",
      floodCheck: "Flood zone / environmental check",
      titleSearch: "Title search initiated",
      walkthrough: "Drive-by or virtual walkthrough done",
      sellerMotivation: "Seller motivation assessed",
      exitStrategy: "Exit strategy confirmed",
    },
    phase2: {
      offerSubmitted: "Offer submitted / under contract",
      earnestMoney: "Earnest money deposited",
      lenderIdentified: "Lender identified and contacted",
      loanApplication: "Loan application submitted",
      insuranceQuotes: "Insurance quotes obtained",
      inspectionScheduled: "Inspection scheduled",
      appraisalOrdered: "Appraisal ordered (if required)",
      contractorWalkthrough: "Contractor walk-through scheduled",
      scopeOfWork: "Scope of work drafted",
      rehabBudget: "Rehab budget finalized",
    },
    phase3: {
      termSheet: "Term sheet received and reviewed",
      loanDocsSigned: "Loan docs signed",
      titleClear: "Title clear / title insurance bound",
      closingDate: "Closing date confirmed",
      wireInstructions: "Wire instructions verified",
      closingFunds: "Closing funds confirmed",
      insuranceBound: "Property insurance bound",
      utilitiesTransferred: "Utilities transferred",
      keysReceived: "Keys received",
      closingDocsFiled: "Closing docs filed",
    },
    phase4: {
      contractorAgreement: "Contractor agreement signed",
      permits: "Permits pulled (if needed)",
      demoComplete: "Demo complete",
      roughInspections: "Rough-in inspections passed",
      materialsOrdered: "Materials ordered / delivered",
      finishWork: "Finish work in progress",
      finalInspection: "Final inspection passed",
      punchList: "Punch list complete",
      cleaned: "Property cleaned and staged",
      photos: "Professional photos taken",
    },
    phase5: {
      refiSeasoning: "Refinance: Seasoning period met",
      refiAppraisal: "Refinance: New appraisal ordered",
      refiApplication: "Refinance: DSCR loan application submitted",
      refiDocsSigned: "Refinance: New loan docs signed",
      refiOriginalPaidOff: "Refinance: Original loan paid off",
      rentListing: "Rent: Listing created",
      tenantScreened: "Rent: Tenant screened and approved",
      leaseSigned: "Rent: Lease signed",
      propertyManagement: "Rent: Property management set up",
      firstRent: "Rent: First rent collected",
    },
  };

  const STRATEGY_LABELS = { "fix-flip": "Fix & Flip", brrrr: "BRRRR", "buy-hold": "Buy & Hold", wholesale: "Wholesale", "new-construction": "New Construction" };
  const STATUS_LABELS = { prospecting: "Prospecting", "under-contract": "Under Contract", closing: "Closing", rehab: "Rehab", exit: "Exit", complete: "Complete", dead: "Dead" };

  function fmtDealDollar(v) { if (!v && v !== 0) return "—"; return "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
  function fmtPct(v) { if (!v && v !== 0) return "—"; return Number(v).toFixed(1) + "%"; }

  async function loadDeals() {
    try {
      const snap = await db.collection("deal-analyzer").orderBy("createdAt", "desc").limit(500).get();
      allDeals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderDealsTable();
      renderPortfolioDashboard();
    } catch (err) {
      console.error("Load deals error:", err);
      showToast("Failed to load deals", "error");
    }
  }

  // ===== PORTFOLIO DASHBOARD =====
  var portfolioChartStatus = null, portfolioChartStrategy = null;

  function renderPortfolioDashboard() {
    // Owned = deals where money has actually been committed (closing or later)
    var ownedStatuses = ["closing", "rehab", "exit", "complete"];
    var owned = allDeals.filter(function(d) { return ownedStatuses.indexOf(d.status) !== -1; });
    var pipeline = allDeals.filter(function(d) { return d.status === "prospecting" || d.status === "under-contract"; });

    // Aggregate financials — ONLY from owned deals (capital actually deployed)
    var totalCashInvested = 0, totalProjectCost = 0, totalEquity = 0, totalMonthlyFlow = 0, totalArv = 0;
    var scoredOwned = owned.filter(function(d) { return d.analysis && d.analysis.dealScore; });
    var avgScore = scoredOwned.length ? (scoredOwned.reduce(function(s, d) { return s + d.analysis.dealScore; }, 0) / scoredOwned.length) : 0;

    owned.forEach(function(d) {
      var p = d.property || {};
      var fin = d.financials || {};
      var loanTerms = fin.loanTerms || {};
      var holding = fin.holdingCosts || {};
      var rehabSpent = (fin.rehabLineItems || []).reduce(function(s, i) { return s + (i.amount || 0); }, 0);
      var purchase = fin.actualPurchasePrice || p.purchasePrice || 0;
      var closing = fin.actualClosingCosts || Math.round(purchase * (loanTerms.closingCostPct || 3) / 100);
      var arv = fin.actualArv || p.arv || 0;
      var rehab = rehabSpent || p.rehabCost || 0;
      var origPoints = loanTerms.originationPoints ? Math.round((loanTerms.loanAmount || 0) * loanTerms.originationPoints / 100) : 0;
      // Holding costs
      var holdMonths = holding.holdingMonths || 0;
      var monthlyPmt = calcMonthlyPayment(loanTerms.loanAmount || 0, loanTerms.interestRate || 0, loanTerms.loanTermMonths || 0);
      var holdMonthly = (monthlyPmt || 0) + (holding.holdingInsurance || 0) + (holding.holdingTaxes || 0) + (holding.holdingUtilities || 0) + (holding.holdingOther || 0);
      var totalHolding = Math.round(holdMonthly * holdMonths);
      var projCost = purchase + closing + rehab + totalHolding + origPoints;

      // Cash invested = down payment + closing + rehab + holding + earnest + origination (if financing)
      var downPmt = loanTerms.downPayment || 0;
      var earnest = loanTerms.earnestMoney || 0;
      var cashInv = downPmt > 0 ? (downPmt + closing + rehab + totalHolding + earnest + origPoints) : projCost;

      if (purchase > 0) {
        totalProjectCost += projCost;
        totalCashInvested += cashInv;
        totalArv += arv;
        totalEquity += (arv - projCost);
      }

      var exp = fin.monthlyExpenses || {};
      var totalExp = Object.values(exp).reduce(function(s, v) { return s + (parseFloat(v) || 0); }, 0);
      var rent = p.monthlyRent || 0;
      if (rent > 0 || totalExp > 0) totalMonthlyFlow += (rent - totalExp);
    });

    // Stat cards
    var statsGrid = document.getElementById("portfolio-stats");
    var cards = [
      { label: "Pipeline", value: pipeline.length, style: "color:#2563eb" },
      { label: "Owned", value: owned.length, style: "color:#1a3c6e" },
      { label: "Avg Deal Score", value: avgScore ? avgScore.toFixed(1) + "/10" : "—", style: avgScore >= 7 ? "color:#059669" : avgScore >= 4 ? "color:#d97706" : "color:#dc2626" },
      { label: "Cash Invested", value: fmtDealDollar(totalCashInvested), style: "" },
      { label: "Total ARV", value: fmtDealDollar(totalArv), style: "" },
      { label: "Total Equity", value: fmtDealDollar(totalEquity), style: totalEquity > 0 ? "color:#059669" : "color:#dc2626" },
      { label: "Monthly Cash Flow", value: fmtDealDollar(totalMonthlyFlow), style: totalMonthlyFlow > 0 ? "color:#059669" : totalMonthlyFlow < 0 ? "color:#dc2626" : "" },
      { label: "Portfolio ROI", value: totalCashInvested > 0 ? fmtPct((totalEquity / totalCashInvested) * 100) : "—", style: totalEquity > 0 ? "color:#059669" : "color:#dc2626" },
    ];
    statsGrid.innerHTML = cards.map(function(c) {
      return '<div class="stat-card"><div class="stat-card-label">' + c.label + '</div><div class="stat-card-value" style="' + c.style + '">' + c.value + '</div></div>';
    }).join("");

    // Status chart
    if (portfolioChartStatus) portfolioChartStatus.destroy();
    var statusCounts = {};
    allDeals.forEach(function(d) { var s = d.status || "prospecting"; statusCounts[s] = (statusCounts[s] || 0) + 1; });
    var statusLabels = Object.keys(statusCounts).map(function(k) { return STATUS_LABELS[k] || k; });
    var statusColors = { prospecting:"#2563eb", "under-contract":"#d97706", closing:"#0369a1", rehab:"#a855f7", exit:"#059669", complete:"#16a34a", dead:"#dc2626" };
    var statusBg = Object.keys(statusCounts).map(function(k) { return statusColors[k] || "#94a3b8"; });

    var ctxStatus = document.getElementById("portfolio-chart-status");
    if (ctxStatus && Object.keys(statusCounts).length) {
      portfolioChartStatus = new Chart(ctxStatus, {
        type: "doughnut",
        data: { labels: statusLabels, datasets: [{ data: Object.values(statusCounts), backgroundColor: statusBg, borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: "60%", plugins: { legend: { position: "bottom", labels: { font: { size: 11 }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } } } }
      });
    }

    // Strategy chart
    if (portfolioChartStrategy) portfolioChartStrategy.destroy();
    var strategyCounts = {};
    allDeals.forEach(function(d) { var s = (d.property || {}).strategy || "other"; strategyCounts[s] = (strategyCounts[s] || 0) + 1; });
    var stratLabels = Object.keys(strategyCounts).map(function(k) { return STRATEGY_LABELS[k] || k; });
    var stratColors = ["#1a3c6e", "#c9a84c", "#2d6a4f", "#7c3aed", "#0891b2"];

    var ctxStrat = document.getElementById("portfolio-chart-strategy");
    if (ctxStrat && Object.keys(strategyCounts).length) {
      portfolioChartStrategy = new Chart(ctxStrat, {
        type: "doughnut",
        data: { labels: stratLabels, datasets: [{ data: Object.values(strategyCounts), backgroundColor: stratColors.slice(0, stratLabels.length), borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: "60%", plugins: { legend: { position: "bottom", labels: { font: { size: 11 }, padding: 10, usePointStyle: true, pointStyleWidth: 8 } } } }
      });
    }
  }

  // ===== CSV EXPORT =====
  on("btn-export-csv", "click", function() {
    if (!allDeals.length) { showToast("No deals to export", "error"); return; }
    var headers = ["Address","City","State","Zip","Type","Strategy","Condition","Status","Deal Score","Purchase Price","Rehab Budget","ARV","Monthly Rent","Suggested Offer","70% Rule","LTV","LTC","Est. Profit","Est. Cash Flow","Actual Purchase","Actual Closing","Actual ARV","Rehab Spent","Total Project Cost","Equity","Down Payment","Loan Amount","Interest Rate","Earnest Money","Holding Costs","Cash Invested","Sale Price","Net Proceeds","Refi Appraisal","Cash Out","Contacts","Activity Notes","Documents","Created"];
    var rows = allDeals.map(function(d) {
      var p = d.property || {};
      var a = d.analysis || {};
      var f = a.financials || {};
      var fin = d.financials || {};
      var lt = fin.loanTerms || {};
      var hc = fin.holdingCosts || {};
      var ex = fin.exitData || {};
      var rehabSpent = (fin.rehabLineItems || []).reduce(function(s, i) { return s + (i.amount || 0); }, 0);
      var purchase = fin.actualPurchasePrice || p.purchasePrice || 0;
      var closing = fin.actualClosingCosts || 0;
      var origPts = lt.originationPoints ? Math.round((lt.loanAmount || 0) * lt.originationPoints / 100) : 0;
      var holdMonths = hc.holdingMonths || 0;
      var mp = calcMonthlyPayment(lt.loanAmount || 0, lt.interestRate || 0, lt.loanTermMonths || 0);
      var holdMonthly = (mp || 0) + (hc.holdingInsurance || 0) + (hc.holdingTaxes || 0) + (hc.holdingUtilities || 0) + (hc.holdingOther || 0);
      var totalHolding = Math.round(holdMonthly * holdMonths);
      var projCost = purchase + closing + rehabSpent + totalHolding + origPts;
      var equity = (fin.actualArv || p.arv || 0) - projCost;
      var cashInv = lt.downPayment > 0 ? (lt.downPayment + closing + rehabSpent + totalHolding + (lt.earnestMoney || 0) + origPts) : projCost;
      var saleNet = ex.salePrice ? (ex.salePrice - Math.round(ex.salePrice * (ex.agentCommission || 5) / 100) - (ex.sellerClosingCosts || 0)) : "";
      var cashOut = ex.refiLoanAmount && lt.loanAmount ? (ex.refiLoanAmount - lt.loanAmount) : "";
      return [
        p.address || "", p.city || "", p.state || "", p.zip || "",
        p.type || "", STRATEGY_LABELS[p.strategy] || p.strategy || "", p.condition || "",
        STATUS_LABELS[d.status] || d.status || "", a.dealScore || "",
        p.purchasePrice || "", p.rehabCost || "", p.arv || "", p.monthlyRent || "",
        a.suggestedOffer || "", f.passes70Rule ? "PASS" : "FAIL",
        f.ltv ? f.ltv.toFixed(1) + "%" : "", f.ltc ? f.ltc.toFixed(1) + "%" : "",
        f.estimatedProfit || "", f.monthlyCashFlow || "",
        fin.actualPurchasePrice || "", fin.actualClosingCosts || "", fin.actualArv || "",
        rehabSpent || "", projCost || "", equity || "",
        lt.downPayment || "", lt.loanAmount || "", lt.interestRate || "", lt.earnestMoney || "",
        totalHolding || "", cashInv || "",
        ex.salePrice || "", saleNet, ex.refiAppraisal || "", cashOut,
        (d.contacts || []).length, (d.activityLog || []).length, (d.documents || []).length,
        d.createdAt ? new Date(d.createdAt).toLocaleDateString() : ""
      ];
    });
    var csv = [headers].concat(rows).map(function(row) {
      return row.map(function(cell) { return '"' + String(cell).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\n");
    var blob = new Blob([csv], { type: "text/csv" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "umbrella-place-deals-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(url);
    showToast("CSV exported", "success");
  });

  // ===== DEAL CLONING =====
  on("btn-clone-deal", "click", async function() {
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (!deal) return;
    if (!confirm("Clone this deal? A new deal will be created with the same property details and a fresh AI analysis.")) return;

    var btn = document.getElementById("btn-clone-deal");
    btn.disabled = true;
    btn.textContent = "Cloning...";

    try {
      var token = await currentUser.getIdToken();
      var res = await fetch(FUNCTIONS_BASE + "/analyzeDeal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ property: deal.property }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "Clone failed");

      var newDeal = { id: data.dealId, property: deal.property, analysis: data.analysis, checklists: { phase1:{}, phase2:{}, phase3:{}, phase4:{}, phase5:{} }, status: "prospecting", activityLog: [], contacts: [], financials: { rehabLineItems: [], monthlyExpenses: {} }, documents: [], keyDates: {}, createdAt: new Date().toISOString() };
      allDeals.unshift(newDeal);
      showToast("Deal cloned — opening new copy", "success");
      openDealDetail(data.dealId);
    } catch (err) {
      showToast(err.message || "Clone failed", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Clone Deal";
    }
  });

  function renderDealsTable() {
    const tbody = document.getElementById("deals-table-body");
    const empty = document.getElementById("deals-empty");
    const statusFilter = document.getElementById("deal-filter-status").value;
    const strategyFilter = document.getElementById("deal-filter-strategy").value;
    const searchFilter = (document.getElementById("deal-filter-search").value || "").toLowerCase();

    let filtered = allDeals;
    if (statusFilter) filtered = filtered.filter(d => d.status === statusFilter);
    if (strategyFilter) filtered = filtered.filter(d => d.property?.strategy === strategyFilter);
    if (searchFilter) filtered = filtered.filter(d => (d.property?.address || "").toLowerCase().includes(searchFilter) || (d.property?.city || "").toLowerCase().includes(searchFilter));

    if (filtered.length === 0) {
      tbody.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    tbody.innerHTML = filtered.map(d => {
      const p = d.property || {};
      const score = d.analysis?.dealScore || 0;
      const scoreClass = score >= 7 ? "score-good" : score >= 4 ? "score-mid" : "score-bad";
      const date = d.createdAt ? new Date(d.createdAt).toLocaleDateString() : "—";
      return `<tr style="cursor:pointer" data-deal-id="${d.id}">
        <td><strong>${escHtml(p.address || "—")}</strong><br><span style="font-size:0.75rem;color:var(--text-muted)">${escHtml(p.city || "")}${p.state ? ", " + p.state : ""}</span></td>
        <td>${STRATEGY_LABELS[p.strategy] || p.strategy || "—"}</td>
        <td><span class="deal-score-sm ${scoreClass}">${score}</span></td>
        <td>${fmtDealDollar(p.purchasePrice)}</td>
        <td><span class="status-badge badge-${d.status || "prospecting"}">${STATUS_LABELS[d.status] || d.status || "—"}</span></td>
        <td>${date}</td>
        <td><button class="btn btn-secondary btn-sm deal-row-delete" data-deal-id="${d.id}" style="padding:0.15rem 0.4rem;font-size:0.65rem;color:#dc2626">&times;</button></td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll("tr[data-deal-id]").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".deal-row-delete")) return;
        openDealDetail(row.dataset.dealId);
      });
    });

    tbody.querySelectorAll(".deal-row-delete").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        var id = btn.dataset.dealId;
        if (!confirm("Delete this deal?")) return;
        try {
          await db.collection("deal-analyzer").doc(id).delete();
          allDeals = allDeals.filter(function(d) { return d.id !== id; });
          renderDealsTable();
          renderPortfolioDashboard();
          showToast("Deal deleted", "success");
        } catch (err) { showToast("Failed to delete", "error"); }
      });
    });
  }

  // Sub-view navigation
  function showDealsList() {
    flushDealSave(); // save any pending changes before navigating away
    document.getElementById("deals-list-card").style.display = "";
    document.getElementById("deal-form-section").style.display = "none";
    document.getElementById("deal-detail-section").style.display = "none";
    currentDealId = null;
  }
  function showDealForm() {
    document.getElementById("deals-list-card").style.display = "none";
    document.getElementById("deal-form-section").style.display = "";
    document.getElementById("deal-detail-section").style.display = "none";
    // Clear form
    ["deal-address","deal-city","deal-zip","deal-purchase-price","deal-rehab-cost","deal-arv","deal-rent","deal-sqft","deal-year-built","deal-beds","deal-baths","deal-listing-url","deal-notes"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    document.getElementById("deal-state").value = "";
  }

  // Analyze deal
  on("btn-new-deal", "click", showDealForm);
  on("btn-cancel-deal", "click", showDealsList);
  on("btn-back-to-deals", "click", () => { showDealsList(); loadDeals(); });

  on("btn-analyze-deal", "click", async () => {
    const property = {
      address: document.getElementById("deal-address").value.trim(),
      city: document.getElementById("deal-city").value.trim(),
      state: document.getElementById("deal-state").value,
      zip: document.getElementById("deal-zip").value.trim(),
      type: document.getElementById("deal-property-type").value,
      strategy: document.getElementById("deal-strategy").value,
      condition: document.getElementById("deal-condition").value,
      purchasePrice: parseInt(document.getElementById("deal-purchase-price").value) || 0,
      rehabCost: parseInt(document.getElementById("deal-rehab-cost").value) || 0,
      arv: parseInt(document.getElementById("deal-arv").value) || 0,
      monthlyRent: parseInt(document.getElementById("deal-rent").value) || 0,
      sqft: parseInt(document.getElementById("deal-sqft").value) || 0,
      beds: parseInt(document.getElementById("deal-beds").value) || 0,
      baths: parseInt(document.getElementById("deal-baths").value) || 0,
      yearBuilt: parseInt(document.getElementById("deal-year-built").value) || 0,
      source: document.getElementById("deal-source").value,
      listingUrl: document.getElementById("deal-listing-url").value.trim(),
      notes: document.getElementById("deal-notes").value.trim(),
    };

    if (!property.address) { showToast("Property address is required", "error"); return; }

    // Input validation
    var errors = [];
    if (property.purchasePrice < 0) errors.push("Purchase price can't be negative");
    if (property.rehabCost < 0) errors.push("Rehab cost can't be negative");
    if (property.arv < 0) errors.push("ARV can't be negative");
    if (property.monthlyRent < 0) errors.push("Rent can't be negative");
    if (property.sqft < 0) errors.push("Sqft can't be negative");
    if (property.beds < 0 || property.beds > 20) errors.push("Beds should be 0-20");
    if (property.baths < 0 || property.baths > 15) errors.push("Baths should be 0-15");
    if (property.yearBuilt && (property.yearBuilt < 1800 || property.yearBuilt > new Date().getFullYear() + 2)) errors.push("Year built looks wrong");
    if (errors.length) { showToast(errors[0], "error"); return; }

    // Warnings (don't block, just confirm)
    if (property.purchasePrice && property.arv && property.purchasePrice > property.arv) {
      if (!confirm("Purchase price ($" + property.purchasePrice.toLocaleString() + ") is higher than ARV ($" + property.arv.toLocaleString() + "). Continue anyway?")) return;
    }
    if (property.purchasePrice && property.purchasePrice < 10000) {
      if (!confirm("Purchase price is under $10,000. Is this correct?")) return;
    }

    const btn = document.getElementById("btn-analyze-deal");
    btn.disabled = true;
    btn.textContent = "Analyzing with AI...";

    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/analyzeDeal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ property }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");

      // Add to local list and open detail
      const newDeal = { id: data.dealId, property, analysis: data.analysis, checklists: { phase1:{}, phase2:{}, phase3:{}, phase4:{}, phase5:{} }, status: "prospecting", activityLog: [], contacts: [], financials: { rehabLineItems: [], monthlyExpenses: {} }, documents: [], keyDates: {}, createdAt: new Date().toISOString() };
      allDeals.unshift(newDeal);
      showToast("Deal analyzed successfully", "success");
      openDealDetail(data.dealId);
    } catch (err) {
      console.error("Analyze deal error:", err);
      showToast(err.message || "Analysis failed", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Analyze Deal with AI";
    }
  });

  // Open detail view
  function openDealDetail(id) {
    const deal = allDeals.find(d => d.id === id);
    if (!deal) { showToast("Deal not found", "error"); return; }
    currentDealId = id;
    currentPhase = "phase1";

    document.getElementById("deals-list-card").style.display = "none";
    document.getElementById("deal-form-section").style.display = "none";
    document.getElementById("deal-detail-section").style.display = "";

    renderDealResults(deal);
    renderDealDates(deal);
    renderDealActuals(deal);
    renderDealActivity(deal);
    renderDealContacts(deal);
    renderDealDocuments(deal);
    renderDealChecklists(deal);
    renderDealMap(deal);
    renderDealFloorPlan(deal);

    document.getElementById("deal-detail-status").value = deal.status || "prospecting";
  }

  function renderDealResults(deal) {
    const p = deal.property || {};
    const a = deal.analysis || {};
    const f = a.financials || {};
    const score = a.dealScore || 0;

    // Score badge
    const badge = document.getElementById("deal-score-badge");
    if (score >= 1 && score <= 10) {
      badge.textContent = score;
      badge.className = "deal-score-badge " + (score >= 7 ? "score-good" : score >= 4 ? "score-mid" : "score-bad");
    } else {
      badge.textContent = "?";
      badge.className = "deal-score-badge score-mid";
      badge.title = "AI analysis may have failed — try re-analyzing";
    }

    // Header
    document.getElementById("deal-detail-address").textContent = `${p.address || "Unknown"}${p.city ? ", " + p.city : ""}${p.state ? ", " + p.state : ""}`;
    document.getElementById("deal-detail-subtitle").textContent = `${STRATEGY_LABELS[p.strategy] || p.strategy || ""} | ${p.type || ""} | ${p.condition || ""}`;

    // Executive Summary
    const summaryEl = document.getElementById("deal-summary");
    if (a.summary) {
      summaryEl.innerHTML = a.summary.split("\n").filter(s => s.trim()).map(para => `<p style="font-size:0.9rem;line-height:1.75;margin-bottom:0.75rem;color:var(--text-primary,#111827)">${escHtml(para)}</p>`).join("");
    } else {
      summaryEl.innerHTML = `<p style="font-size:0.875rem;color:var(--text-muted)">No summary available. Re-analyze to generate one.</p>`;
    }

    // 70% rule
    const rule70 = document.getElementById("deal-70-rule-body");
    const maxPrice = f.maxPurchasePrice70 || 0;
    const passes = f.passes70Rule;
    rule70.innerHTML = `
      <div class="rule-verdict ${passes ? "pass" : "fail"}">
        <span class="rule-icon">${passes ? "&#10003;" : "&#10007;"}</span>
        <div>
          <div>70% Rule: ${passes ? "PASS" : "FAIL"}</div>
          <div class="rule-numbers">Max purchase: ${fmtDealDollar(maxPrice)} (ARV ${fmtDealDollar(p.arv)} &times; 70% &minus; ${fmtDealDollar(p.rehabCost)} rehab) &mdash; Asking: ${fmtDealDollar(p.purchasePrice)}</div>
        </div>
      </div>`;

    // Financial metrics grid — color-coded
    const grid = document.getElementById("deal-financials-grid");
    function mc(val, goodAbove, badBelow) {
      if (val === null || val === undefined) return "";
      var n = parseFloat(val);
      if (isNaN(n)) return "";
      if (n >= goodAbove) return "color:#059669";
      if (n <= badBelow) return "color:#dc2626";
      return "color:#d97706";
    }
    const profit = f.estimatedProfit || 0;
    const equity = f.equityAfterRehab || 0;
    const cashFlow = f.monthlyCashFlow || 0;
    const isRental = ["brrrr", "buy-hold"].includes(p.strategy);
    const isFlip = ["fix-flip", "wholesale"].includes(p.strategy);

    var metrics = [
      { label: "Total Project Cost", value: fmtDealDollar(f.totalProjectCost), style: "" },
      { label: "Equity After Rehab", value: fmtDealDollar(equity), style: mc(equity, 30000, 0) },
      { label: "Estimated Profit", value: fmtDealDollar(profit), style: mc(profit, 25000, 0) },
      { label: "Suggested Offer", value: fmtDealDollar(a.suggestedOffer), style: "color:#1a3c6e;font-weight:800" },
      { label: "LTV", value: fmtPct(f.ltv), style: mc(f.ltv, 0, 0) === "" ? "" : (f.ltv <= 70 ? "color:#059669" : f.ltv <= 80 ? "color:#d97706" : "color:#dc2626") },
      { label: "LTC", value: fmtPct(f.ltc), style: mc(f.ltc, 0, 0) === "" ? "" : (f.ltc <= 75 ? "color:#059669" : f.ltc <= 85 ? "color:#d97706" : "color:#dc2626") },
      { label: "Cash-on-Cash", value: fmtPct(f.cashOnCashReturn), style: mc(f.cashOnCashReturn, 12, 5) },
    ];

    // Add rental-specific metrics only for rental strategies
    if (isRental) {
      metrics.push({ label: "Cap Rate", value: fmtPct(f.capRate), style: mc(f.capRate, 7, 4) });
      metrics.push({ label: "Monthly Cash Flow", value: fmtDealDollar(cashFlow), style: mc(cashFlow, 200, 0) });
      metrics.push({ label: "DSCR", value: f.dscr ? Number(f.dscr).toFixed(2) + "x" : "—", style: f.dscr ? (f.dscr >= 1.25 ? "color:#059669" : f.dscr >= 1.0 ? "color:#d97706" : "color:#dc2626") : "" });
    }
    grid.innerHTML = metrics.map(m => `
      <div class="stat-card">
        <div class="stat-card-label">${m.label}</div>
        <div class="stat-card-value" style="${m.style}">${m.value}</div>
      </div>`).join("");

    // --- Charts ---
    renderDealCharts(deal);

    // Risks
    document.getElementById("deal-risks").innerHTML = (a.risks && a.risks.length)
      ? `<ul class="deal-list">${a.risks.map(r => `<li>${escHtml(r)}</li>`).join("")}</ul>`
      : "<p>No risks identified</p>";

    // Recommendations
    document.getElementById("deal-recommendations").innerHTML = (a.recommendations && a.recommendations.length)
      ? `<ul class="deal-list">${a.recommendations.map(r => `<li>${escHtml(r)}</li>`).join("")}</ul>`
      : "<p>No recommendations</p>";

    // AI Estimates
    const estCard = document.getElementById("deal-estimates-card");
    const est = a.estimatedValues;
    if (est && est.notes) {
      estCard.style.display = "";
      let estHtml = "";
      if (est.arv) estHtml += `<div class="stat-card" style="display:inline-block;margin:0 0.5rem 0.5rem 0"><div class="stat-card-label">Est. ARV</div><div class="stat-card-value">${fmtDealDollar(est.arv)}</div></div>`;
      if (est.rehabCost) estHtml += `<div class="stat-card" style="display:inline-block;margin:0 0.5rem 0.5rem 0"><div class="stat-card-label">Est. Rehab</div><div class="stat-card-value">${fmtDealDollar(est.rehabCost)}</div></div>`;
      if (est.monthlyRent) estHtml += `<div class="stat-card" style="display:inline-block;margin:0 0.5rem 0.5rem 0"><div class="stat-card-label">Est. Rent</div><div class="stat-card-value">${fmtDealDollar(est.monthlyRent)}/mo</div></div>`;
      estHtml += `<p style="font-size:0.85rem;line-height:1.6;margin-top:0.75rem;color:var(--text-secondary)">${escHtml(est.notes)}</p>`;
      document.getElementById("deal-estimates").innerHTML = estHtml;
    } else {
      estCard.style.display = "none";
    }

    // Comps
    const compsCard = document.getElementById("deal-comps-card");
    const comps = a.comps;
    if (comps && comps.length) {
      compsCard.style.display = "";
      document.getElementById("deal-comps").innerHTML = `<table class="data-table"><thead><tr><th>Comp</th><th>Price</th><th>Details</th></tr></thead><tbody>${comps.map(c => `<tr><td><strong>${escHtml(c.address || "—")}</strong></td><td>${fmtDealDollar(c.price)}</td><td style="font-size:0.8rem">${escHtml(c.details || "")}</td></tr>`).join("")}</tbody></table>`;
    } else {
      compsCard.style.display = "none";
    }

    // Market Analysis
    document.getElementById("deal-market-analysis").innerHTML = `<p style="font-size:0.875rem;line-height:1.7">${escHtml(a.marketAnalysis || a.compNotes || "No market analysis available")}</p>`;

    // Score reasoning
    const scoreCard = document.getElementById("deal-score-badge").parentElement;
    const existingReasoning = scoreCard.querySelector(".score-reasoning");
    if (existingReasoning) existingReasoning.remove();
    if (a.scoreReasoning) {
      const reasonEl = document.createElement("p");
      reasonEl.className = "score-reasoning";
      reasonEl.style.cssText = "font-size:0.8rem;color:var(--text-muted,#9ca3af);margin-top:0.5rem;grid-column:1/-1";
      reasonEl.textContent = a.scoreReasoning;
      scoreCard.appendChild(reasonEl);
    }
  }

  // Deal charts
  var dealChartCosts = null, dealChartScore = null, dealChartArv = null;

  function renderDealCharts(deal) {
    const p = deal.property || {};
    const a = deal.analysis || {};
    const f = a.financials || {};
    const est = a.estimatedValues || {};

    const purchase = p.purchasePrice || est.arv * 0.7 || 0;
    const rehab = p.rehabCost || est.rehabCost || 0;
    const closing = Math.round(purchase * 0.03);
    const arv = p.arv || est.arv || 0;
    const totalCost = f.totalProjectCost || (purchase + rehab + closing);
    const equityOrProfit = f.equityAfterRehab || 0;
    const score = a.dealScore || 0;

    // Destroy old charts
    if (dealChartCosts) dealChartCosts.destroy();
    if (dealChartScore) dealChartScore.destroy();
    if (dealChartArv) dealChartArv.destroy();

    // 1. Cost Breakdown — Donut
    var ctxCosts = document.getElementById("deal-chart-costs");
    if (ctxCosts && (purchase || rehab)) {
      dealChartCosts = new Chart(ctxCosts, {
        type: "doughnut",
        data: {
          labels: ["Purchase", "Rehab", "Closing Costs"],
          datasets: [{
            data: [purchase, rehab, closing],
            backgroundColor: ["#1a3c6e", "#c9a84c", "#94a3b8"],
            borderWidth: 0,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "65%",
          plugins: {
            legend: { position: "bottom", labels: { font: { size: 11 }, padding: 12, usePointStyle: true, pointStyleWidth: 8 } },
            tooltip: { callbacks: { label: function(ctx) { return ctx.label + ": " + fmtDealDollar(ctx.raw); } } }
          }
        }
      });
    }

    // 2. Deal Score — Doughnut gauge
    var ctxScore = document.getElementById("deal-chart-score");
    if (ctxScore) {
      var scoreColor = score >= 7 ? "#059669" : score >= 4 ? "#d97706" : "#dc2626";
      dealChartScore = new Chart(ctxScore, {
        type: "doughnut",
        data: {
          labels: ["Score", "Remaining"],
          datasets: [{
            data: [score, 10 - score],
            backgroundColor: [scoreColor, "#f3f4f6"],
            borderWidth: 0,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "75%",
          rotation: -90,
          circumference: 180,
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
          }
        },
        plugins: [{
          id: "scoreText",
          afterDraw: function(chart) {
            var ctx2 = chart.ctx;
            var w = chart.width, h = chart.height;
            ctx2.save();
            ctx2.font = "bold 2.5rem Inter, sans-serif";
            ctx2.fillStyle = scoreColor;
            ctx2.textAlign = "center";
            ctx2.textBaseline = "bottom";
            ctx2.fillText(score + "/10", w / 2, h - 20);
            ctx2.font = "500 0.75rem Inter, sans-serif";
            ctx2.fillStyle = "#9ca3af";
            ctx2.fillText(score >= 7 ? "Strong Deal" : score >= 4 ? "Moderate" : "Weak Deal", w / 2, h - 2);
            ctx2.restore();
          }
        }]
      });
    }

    // 3. ARV vs Costs — Bar chart
    var ctxArv = document.getElementById("deal-chart-arv");
    if (ctxArv && arv) {
      dealChartArv = new Chart(ctxArv, {
        type: "bar",
        data: {
          labels: ["Purchase", "Rehab", "Total Cost", "ARV"],
          datasets: [{
            data: [purchase, rehab, totalCost, arv],
            backgroundColor: [
              "#1a3c6e",
              "#c9a84c",
              totalCost > arv ? "#dc2626" : "#d97706",
              "#059669"
            ],
            borderRadius: 4,
            barPercentage: 0.65,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: function(ctx) { return fmtDealDollar(ctx.raw); } } }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: function(v) { return v >= 1000 ? "$" + (v/1000) + "k" : "$" + v; }, font: { size: 10 } },
              grid: { color: "#f3f4f6" },
            },
            x: { ticks: { font: { size: 10 } }, grid: { display: false } }
          }
        }
      });
    }
  }

  // ===== LIFECYCLE: KEY DATES =====
  function renderDealDates(deal) {
    var dates = deal.keyDates || {};
    document.querySelectorAll(".deal-date-input").forEach(function(inp) {
      inp.value = dates[inp.dataset.field] || "";
    });
  }

  document.querySelectorAll(".deal-date-input").forEach(function(inp) {
    inp.addEventListener("change", function() {
      if (!currentDealId) return;
      var deal = allDeals.find(function(d) { return d.id === currentDealId; });
      if (deal) { if (!deal.keyDates) deal.keyDates = {}; deal.keyDates[inp.dataset.field] = inp.value; }
      queueDealFieldSave("keyDates." + inp.dataset.field, inp.value);
    });
  });

  // ===== LIFECYCLE: FINANCIAL TRACKER =====
  function uid() { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }

  function calcMonthlyPayment(principal, annualRate, termMonths) {
    if (!principal || !annualRate || !termMonths) return 0;
    var r = (annualRate / 100) / 12;
    var n = termMonths;
    if (r === 0) return principal / n;
    return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  }

  function renderDealActuals(deal) {
    var fin = deal.financials || {};
    var exp = fin.monthlyExpenses || {};
    var items = fin.rehabLineItems || [];
    var p = deal.property || {};
    var aiFin = (deal.analysis || {}).financials || {};
    var loanTerms = fin.loanTerms || {};
    var holding = fin.holdingCosts || {};
    var exitData = fin.exitData || {};

    // Populate actual inputs
    document.getElementById("deal-actual-purchase").value = fin.actualPurchasePrice || "";
    document.getElementById("deal-actual-closing").value = fin.actualClosingCosts || "";
    document.getElementById("deal-actual-arv").value = fin.actualArv || "";

    // Populate expense inputs
    ["insurance","taxes","hoa","utilities","propertyManagement","other"].forEach(function(k) {
      var el = document.querySelector('.deal-expense-input[data-field="' + k + '"]');
      if (el) el.value = exp[k] || "";
    });

    // Populate financing inputs
    ["downPayment","interestRate","loanTermMonths","earnestMoney","loanAmount","originationPoints","closingCostPct"].forEach(function(k) {
      var el = document.querySelector('.deal-financing-input[data-field="' + k + '"]');
      if (el) el.value = loanTerms[k] || "";
    });

    // Calc & show monthly payment
    var monthlyPmt = calcMonthlyPayment(loanTerms.loanAmount || 0, loanTerms.interestRate || 0, loanTerms.loanTermMonths || 0);
    document.getElementById("deal-fin-payment").value = monthlyPmt ? Math.round(monthlyPmt) : "";

    // Populate holding cost inputs
    ["holdingInsurance","holdingTaxes","holdingUtilities","holdingMonths","holdingOther"].forEach(function(k) {
      var el = document.querySelector('.deal-holding-input[data-field="' + k + '"]');
      if (el) el.value = holding[k] || "";
    });
    // Auto-fill loan holding from monthly payment
    document.getElementById("deal-hold-loan").value = monthlyPmt ? Math.round(monthlyPmt) : "";

    // Calc total holding costs
    var holdMonths = holding.holdingMonths || 0;
    var holdMonthly = (monthlyPmt || 0) + (holding.holdingInsurance || 0) + (holding.holdingTaxes || 0) + (holding.holdingUtilities || 0) + (holding.holdingOther || 0);
    var totalHolding = Math.round(holdMonthly * holdMonths);
    document.getElementById("deal-hold-total").textContent = fmtDealDollar(totalHolding);
    document.getElementById("deal-hold-total").style.color = totalHolding > 0 ? "#dc2626" : "";

    // Populate exit inputs
    ["listingPrice","salePrice","daysOnMarket","offersReceived","agentCommission","sellerClosingCosts","refiAppraisal","refiLoanAmount","refiRate","refiTerm"].forEach(function(k) {
      var el = document.querySelector('.deal-exit-input[data-field="' + k + '"]');
      if (el) el.value = exitData[k] || "";
    });

    // Rehab table
    renderRehabTable(deal);

    // P&L summary — now includes holding costs and real cash tracking
    var rehabTotal = items.reduce(function(s, i) { return s + (i.amount || 0); }, 0);
    var actualPurch = fin.actualPurchasePrice || p.purchasePrice || 0;
    var actualClose = fin.actualClosingCosts || 0;
    var origPoints = loanTerms.originationPoints ? Math.round((loanTerms.loanAmount || 0) * loanTerms.originationPoints / 100) : 0;
    var totalProjectCost = actualPurch + actualClose + rehabTotal + totalHolding + origPoints;
    var actualArv = fin.actualArv || p.arv || 0;
    var equity = actualArv - totalProjectCost;
    var monthlyRent = p.monthlyRent || 0;
    var totalExp = Object.values(exp).reduce(function(s, v) { return s + (parseFloat(v) || 0); }, 0);
    var monthlyCF = monthlyRent - totalExp;

    // Cash invested = down payment + closing + rehab out of pocket + holding + earnest + origination
    var downPmt = loanTerms.downPayment || 0;
    var earnest = loanTerms.earnestMoney || 0;
    var cashInvested = downPmt > 0 ? (downPmt + actualClose + rehabTotal + totalHolding + earnest + origPoints) : totalProjectCost;
    var cashOnCash = cashInvested > 0 && monthlyCF > 0 ? ((monthlyCF * 12) / cashInvested * 100) : 0;

    // Real DSCR from actual loan payment
    var realDSCR = monthlyPmt > 0 && monthlyRent > 0 ? (monthlyRent / monthlyPmt) : 0;

    var grid = document.getElementById("deal-actuals-grid");
    var summaryMetrics = [
      { label: "Total Project Cost", value: fmtDealDollar(totalProjectCost), style: "" },
      { label: "Cash Invested", value: downPmt > 0 ? fmtDealDollar(cashInvested) : "Enter loan terms", style: downPmt > 0 ? "color:#1a3c6e" : "color:#94a3b8;font-size:0.75rem" },
      { label: "Rehab Spent", value: fmtDealDollar(rehabTotal), style: rehabTotal > (p.rehabCost || 0) ? "color:#dc2626" : "color:#059669" },
      { label: "Holding Costs", value: fmtDealDollar(totalHolding), style: totalHolding > 0 ? "color:#dc2626" : "" },
      { label: "Equity Position", value: fmtDealDollar(equity), style: equity > 0 ? "color:#059669" : "color:#dc2626" },
      { label: "Cash-on-Cash ROI", value: cashOnCash > 0 ? fmtPct(cashOnCash) : "—", style: cashOnCash >= 12 ? "color:#059669" : cashOnCash >= 5 ? "color:#d97706" : cashOnCash > 0 ? "color:#dc2626" : "" },
      { label: "Monthly Cash Flow", value: monthlyRent ? fmtDealDollar(monthlyCF) : "N/A", style: monthlyCF > 0 ? "color:#059669" : monthlyCF < 0 ? "color:#dc2626" : "" },
      { label: "DSCR (Actual)", value: realDSCR > 0 ? realDSCR.toFixed(2) + "x" : "—", style: realDSCR >= 1.25 ? "color:#059669" : realDSCR >= 1.0 ? "color:#d97706" : realDSCR > 0 ? "color:#dc2626" : "" },
    ];
    grid.innerHTML = summaryMetrics.map(function(m) {
      return '<div class="stat-card"><div class="stat-card-label">' + m.label + '</div><div class="stat-card-value" style="' + m.style + '">' + m.value + '</div></div>';
    }).join("");

    // Render exit calculations
    renderExitCalcs(deal, totalProjectCost, cashInvested, actualArv);

    // Show/hide exit sections based on strategy
    var strategy = (p.strategy || "").toLowerCase();
    var isRental = strategy === "brrrr" || strategy === "buy-hold";
    var isFlip = strategy === "fix-flip" || strategy === "wholesale" || strategy === "new-construction";
    document.getElementById("exit-flip-section").style.display = isRental ? "none" : "";
    document.getElementById("exit-refi-section").style.display = isFlip && !isRental ? "none" : "";
  }

  function renderExitCalcs(deal, totalProjectCost, cashInvested, arv) {
    var exitData = ((deal.financials || {}).exitData) || {};

    // Flip exit calcs
    var salePrice = exitData.salePrice || 0;
    var commission = exitData.agentCommission || 5;
    var sellerClose = exitData.sellerClosingCosts || 0;
    var commissionAmt = Math.round(salePrice * commission / 100);
    var netProceeds = salePrice - commissionAmt - sellerClose;
    var trueProfitFlip = netProceeds - totalProjectCost;
    document.getElementById("exit-net-proceeds").textContent = salePrice ? fmtDealDollar(netProceeds) : "$0";
    document.getElementById("exit-net-proceeds").style.color = netProceeds > 0 ? "#059669" : "#dc2626";
    document.getElementById("exit-true-profit").textContent = salePrice ? fmtDealDollar(trueProfitFlip) : "$0";
    document.getElementById("exit-true-profit").style.color = trueProfitFlip > 0 ? "#059669" : "#dc2626";

    // BRRRR refi calcs
    var refiAppraisal = exitData.refiAppraisal || 0;
    var refiLoan = exitData.refiLoanAmount || 0;
    var refiRate = exitData.refiRate || 0;
    var refiTermYrs = exitData.refiTerm || 30;
    var originalLoan = ((deal.financials || {}).loanTerms || {}).loanAmount || 0;
    var cashOut = refiLoan - originalLoan;
    var cashLeft = cashInvested - (cashOut > 0 ? cashOut : 0);
    var arvDelta = refiAppraisal - arv;
    var refiPayment = calcMonthlyPayment(refiLoan, refiRate, refiTermYrs * 12);

    document.getElementById("exit-cash-out").textContent = refiLoan ? fmtDealDollar(cashOut) : "$0";
    document.getElementById("exit-cash-out").style.color = cashOut > 0 ? "#059669" : "#dc2626";
    document.getElementById("exit-cash-left").textContent = refiLoan ? fmtDealDollar(cashLeft) : "$0";
    document.getElementById("exit-cash-left").style.color = cashLeft <= 0 ? "#059669" : "#d97706";
    document.getElementById("exit-arv-delta").textContent = refiAppraisal ? fmtDealDollar(arvDelta) : "$0";
    document.getElementById("exit-arv-delta").style.color = arvDelta > 0 ? "#059669" : arvDelta < 0 ? "#dc2626" : "";
    document.getElementById("exit-refi-payment").textContent = refiPayment ? fmtDealDollar(Math.round(refiPayment)) + "/mo" : "$0";
  }

  function renderRehabTable(deal) {
    var items = ((deal.financials || {}).rehabLineItems || []);
    var tbody = document.getElementById("deal-rehab-tbody");
    var totalEl = document.getElementById("deal-rehab-total");
    if (!tbody) return;
    tbody.innerHTML = items.map(function(item) {
      return '<tr><td>' + escHtml(item.description || "") + '</td><td>' + fmtDealDollar(item.amount) + '</td><td>' + (item.date || "—") + '</td><td><button class="btn btn-secondary btn-sm" style="padding:0.1rem 0.4rem;font-size:0.7rem" data-rehab-id="' + item.id + '">&times;</button></td></tr>';
    }).join("");
    var total = items.reduce(function(s, i) { return s + (i.amount || 0); }, 0);
    totalEl.textContent = "Total: " + fmtDealDollar(total);

    tbody.querySelectorAll("[data-rehab-id]").forEach(function(btn) {
      btn.addEventListener("click", function() { removeRehabItem(btn.dataset.rehabId); });
    });
  }

  // Rehab item add/remove
  on("btn-add-rehab-item", "click", function() {
    var form = document.getElementById("deal-rehab-form");
    form.style.display = form.style.display === "none" ? "" : "none";
  });

  on("btn-save-rehab-item", "click", async function() {
    var desc = document.getElementById("rehab-item-desc").value.trim();
    var amount = parseInt(document.getElementById("rehab-item-amount").value) || 0;
    var date = document.getElementById("rehab-item-date").value;
    if (!desc || !amount) { showToast("Description and amount required", "error"); return; }

    var item = { id: uid(), description: desc, amount: amount, date: date };
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (deal) {
      if (!deal.financials) deal.financials = {};
      if (!deal.financials.rehabLineItems) deal.financials.rehabLineItems = [];
      deal.financials.rehabLineItems.push(item);
    }
    try {
      await db.collection("deal-analyzer").doc(currentDealId).update({
        "financials.rehabLineItems": firebase.firestore.FieldValue.arrayUnion(item),
        updatedAt: new Date().toISOString()
      });
      document.getElementById("rehab-item-desc").value = "";
      document.getElementById("rehab-item-amount").value = "";
      document.getElementById("rehab-item-date").value = "";
      document.getElementById("deal-rehab-form").style.display = "none";
      renderDealActuals(deal);
      showToast("Rehab item added", "success");
    } catch (err) { showToast("Failed to save", "error"); }
  });

  async function removeRehabItem(itemId) {
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (!deal || !deal.financials) return;
    deal.financials.rehabLineItems = (deal.financials.rehabLineItems || []).filter(function(i) { return i.id !== itemId; });
    try {
      await db.collection("deal-analyzer").doc(currentDealId).update({
        "financials.rehabLineItems": deal.financials.rehabLineItems,
        updatedAt: new Date().toISOString()
      });
      renderDealActuals(deal);
    } catch (err) { showToast("Failed to remove", "error"); }
  }

  // ===== DEBOUNCED DEAL FIELD SAVING =====
  // Batches all financial field changes into a single Firestore write after 800ms of inactivity
  var dealSaveQueue = {};
  var dealSaveTimer = null;
  var dealSaveDealId = null;

  function queueDealFieldSave(firestorePath, val) {
    if (!currentDealId) return;
    dealSaveDealId = currentDealId;
    dealSaveQueue[firestorePath] = val;
    clearTimeout(dealSaveTimer);
    // Update UI immediately (local state already updated by caller)
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (deal) renderDealActuals(deal);
    // Debounce the actual Firestore write
    dealSaveTimer = setTimeout(flushDealSave, 800);
  }

  // Save indicator flash
  var saveIndicatorTimer = null;
  function showSaveIndicator() {
    var el = document.getElementById("save-indicator");
    el.style.display = "block"; el.style.opacity = "1";
    clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = setTimeout(function() {
      el.style.opacity = "0";
      setTimeout(function() { el.style.display = "none"; }, 300);
    }, 1500);
  }

  async function flushDealSave() {
    if (!dealSaveDealId || Object.keys(dealSaveQueue).length === 0) return;
    var updates = Object.assign({}, dealSaveQueue);
    updates.updatedAt = new Date().toISOString();
    var id = dealSaveDealId;
    dealSaveQueue = {};
    try {
      await db.collection("deal-analyzer").doc(id).update(updates);
      showSaveIndicator();
    } catch (err) {
      console.error("Batch save error:", err);
      showToast("Failed to save changes", "error");
    }
  }

  // Actual numbers (purchase, closing, ARV)
  document.querySelectorAll(".deal-actual-input").forEach(function(inp) {
    inp.addEventListener("blur", function() {
      if (!currentDealId) return;
      var val = parseInt(inp.value) || 0;
      var deal = allDeals.find(function(d) { return d.id === currentDealId; });
      if (deal) { if (!deal.financials) deal.financials = {}; deal.financials[inp.dataset.field] = val; }
      queueDealFieldSave("financials." + inp.dataset.field, val);
    });
  });

  // Monthly expenses
  document.querySelectorAll(".deal-expense-input").forEach(function(inp) {
    inp.addEventListener("blur", function() {
      if (!currentDealId) return;
      var val = parseFloat(inp.value) || 0;
      var deal = allDeals.find(function(d) { return d.id === currentDealId; });
      if (deal) { if (!deal.financials) deal.financials = {}; if (!deal.financials.monthlyExpenses) deal.financials.monthlyExpenses = {}; deal.financials.monthlyExpenses[inp.dataset.field] = val; }
      queueDealFieldSave("financials.monthlyExpenses." + inp.dataset.field, val);
    });
  });

  // Financing / loan terms
  document.querySelectorAll(".deal-financing-input").forEach(function(inp) {
    if (inp.readOnly) return;
    inp.addEventListener("blur", function() {
      if (!currentDealId) return;
      var val = parseFloat(inp.value) || 0;
      var deal = allDeals.find(function(d) { return d.id === currentDealId; });
      if (deal) { if (!deal.financials) deal.financials = {}; if (!deal.financials.loanTerms) deal.financials.loanTerms = {}; deal.financials.loanTerms[inp.dataset.field] = val; }
      queueDealFieldSave("financials.loanTerms." + inp.dataset.field, val);
    });
  });

  // Holding costs
  document.querySelectorAll(".deal-holding-input").forEach(function(inp) {
    if (inp.readOnly) return;
    inp.addEventListener("blur", function() {
      if (!currentDealId) return;
      var val = parseFloat(inp.value) || 0;
      var deal = allDeals.find(function(d) { return d.id === currentDealId; });
      if (deal) { if (!deal.financials) deal.financials = {}; if (!deal.financials.holdingCosts) deal.financials.holdingCosts = {}; deal.financials.holdingCosts[inp.dataset.field] = val; }
      queueDealFieldSave("financials.holdingCosts." + inp.dataset.field, val);
    });
  });

  // Exit data
  document.querySelectorAll(".deal-exit-input").forEach(function(inp) {
    inp.addEventListener("blur", function() {
      if (!currentDealId) return;
      var val = parseFloat(inp.value) || 0;
      var deal = allDeals.find(function(d) { return d.id === currentDealId; });
      if (deal) { if (!deal.financials) deal.financials = {}; if (!deal.financials.exitData) deal.financials.exitData = {}; deal.financials.exitData[inp.dataset.field] = val; }
      queueDealFieldSave("financials.exitData." + inp.dataset.field, val);
    });
  });

  // ===== MAP & FLOOR PLAN =====
  var dealMap = null;
  var dealMapMarker = null;
  var currentFloorPlan = null;
  var fpZoom = 1;
  var fpCurrentFloor = 1;
  var fpEditMode = false;
  var fpSelectedRoom = null;
  var fpDirty = false;
  var fpScale = 1;
  var fpPadding = 20;
  var fpDrag = null; // {type:'move'|'resize-e'|'resize-s'|'resize-se', roomId, startX, startY, origX, origY, origW, origH}

  function renderDealMap(deal) {
    var p = deal.property || {};
    var address = [p.address, p.city, p.state, p.zip].filter(Boolean).join(", ");
    var mapEl = document.getElementById("deal-map");
    if (dealMap) { dealMap.remove(); dealMap = null; }
    if (!address) {
      mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.85rem">No address provided</div>';
      return;
    }
    dealMap = L.map(mapEl).setView([39.8283, -98.5795], 4);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap', maxZoom: 19
    }).addTo(dealMap);
    fetch("https://nominatim.openstreetmap.org/search?format=json&q=" + encodeURIComponent(address) + "&limit=1", {
      headers: { "User-Agent": "UmbrellaPlace-DealAnalyzer/1.0" }
    })
    .then(function(r) { if (!r.ok) throw new Error("Geocoding failed"); return r.json(); })
    .then(function(results) {
      if (results && results.length > 0) {
        var lat = parseFloat(results[0].lat);
        var lon = parseFloat(results[0].lon);
        dealMap.setView([lat, lon], 17);
        dealMapMarker = L.marker([lat, lon]).addTo(dealMap);
        dealMapMarker.bindPopup("<strong>" + escHtml(p.address || "") + "</strong><br>" + escHtml((p.city || "") + (p.state ? ", " + p.state : ""))).openPopup();
      } else {
        L.marker(dealMap.getCenter()).addTo(dealMap).bindPopup("Address not found on map").openPopup();
      }
    }).catch(function(err) {
      console.warn("Map geocoding error:", err);
      L.marker(dealMap.getCenter()).addTo(dealMap).bindPopup("Could not locate address").openPopup();
    });
    setTimeout(function() { if (dealMap) dealMap.invalidateSize(); }, 300);
  }

  function renderDealFloorPlan(deal) {
    var svg = document.getElementById("floorplan-svg");
    var empty = document.getElementById("floorplan-empty");
    var fp = deal.floorPlan;
    var genBtn = document.getElementById("btn-generate-floorplan");
    fpZoom = 1; fpCurrentFloor = 1; fpEditMode = false; fpSelectedRoom = null; fpDirty = false;
    setEditUI(false);

    if (!fp || !fp.rooms || !fp.rooms.length) {
      svg.style.display = "none"; empty.style.display = ""; currentFloorPlan = null;
      genBtn.textContent = "Generate Floor Plan";
      return;
    }
    genBtn.textContent = "Regenerate Floor Plan";
    currentFloorPlan = JSON.parse(JSON.stringify(fp)); // deep clone for editing
    empty.style.display = "none"; svg.style.display = "";
    var floorSelect = document.getElementById("fp-floor-select");
    floorSelect.style.display = fp.stories > 1 ? "" : "none";
    drawFloorPlan();
  }

  var ROOM_COLORS = {
    living: "#e0f2fe", bedroom: "#ede9fe", bathroom: "#fce7f3", kitchen: "#fef3c7",
    dining: "#d1fae5", garage: "#e5e7eb", laundry: "#e0e7ff", closet: "#f5f5f4",
    hallway: "#f1f5f9", foyer: "#fff7ed", office: "#ecfdf5", pantry: "#fefce8", porch: "#f0fdf4"
  };
  var ROOM_BORDERS = {
    living: "#7dd3fc", bedroom: "#c4b5fd", bathroom: "#f9a8d4", kitchen: "#fcd34d",
    dining: "#6ee7b7", garage: "#9ca3af", laundry: "#a5b4fc", closet: "#d6d3d1",
    hallway: "#cbd5e1", foyer: "#fdba74", office: "#6ee7b7", pantry: "#fde047", porch: "#86efac"
  };

  function snapFt(val) { return Math.round(val); } // snap to 1ft grid

  function drawFloorPlan() {
    var fp = currentFloorPlan;
    if (!fp) return;
    var svg = document.getElementById("floorplan-svg");
    var container = document.getElementById("floorplan-container");
    var rooms = fp.rooms.filter(function(r) { return (r.floor || 1) === fpCurrentFloor; });
    var dims = fp.dimensions || {};
    var planW = dims.width || 60;
    var planH = dims.height || 40;

    // Expand plan bounds if rooms exceed it
    rooms.forEach(function(r) {
      if (r.x + r.width > planW) planW = r.x + r.width + 2;
      if (r.y + r.height > planH) planH = r.y + r.height + 2;
    });

    var cW = container.clientWidth - 20;
    var cH = container.clientHeight - 10 || 380;
    fpScale = Math.min(cW / planW, cH / planH) * 0.85;
    var svgW = Math.round(planW * fpScale + fpPadding * 2);
    var svgH = Math.round(planH * fpScale + fpPadding * 2);

    svg.setAttribute("width", svgW * fpZoom);
    svg.setAttribute("height", svgH * fpZoom);
    svg.setAttribute("viewBox", "0 0 " + svgW + " " + svgH);

    var html = '';
    // Grid in edit mode
    if (fpEditMode) {
      html += '<defs><pattern id="fp-grid" width="' + fpScale + '" height="' + fpScale + '" patternUnits="userSpaceOnUse">';
      html += '<path d="M ' + fpScale + ' 0 L 0 0 0 ' + fpScale + '" fill="none" stroke="#e5e7eb" stroke-width="0.5"/>';
      html += '</pattern></defs>';
      html += '<rect x="' + fpPadding + '" y="' + fpPadding + '" width="' + (planW * fpScale) + '" height="' + (planH * fpScale) + '" fill="url(#fp-grid)" stroke="#d1d5db" stroke-width="1"/>';
    }
    // Background
    html += '<rect x="' + (fpPadding - 2) + '" y="' + (fpPadding - 2) + '" width="' + (planW * fpScale + 4) + '" height="' + (planH * fpScale + 4) + '" fill="none" stroke="#d1d5db" stroke-width="2" rx="3"/>';

    // Rooms — sorted so selected room renders on top
    var sortedRooms = rooms.slice().sort(function(a, b) {
      if (a.id === fpSelectedRoom) return 1;
      if (b.id === fpSelectedRoom) return -1;
      return 0;
    });

    sortedRooms.forEach(function(room) {
      var rx = fpPadding + room.x * fpScale;
      var ry = fpPadding + room.y * fpScale;
      var rw = room.width * fpScale;
      var rh = room.height * fpScale;
      var color = ROOM_COLORS[room.type] || "#f3f4f6";
      var border = ROOM_BORDERS[room.type] || "#9ca3af";
      var isSelected = fpEditMode && room.id === fpSelectedRoom;
      var sqft = Math.round(room.width * room.height);
      var fontSize = Math.max(8, Math.min(12, rw / 8));
      var subFontSize = Math.max(7, fontSize - 2);

      html += '<g class="fp-room" data-room-id="' + room.id + '" style="cursor:' + (fpEditMode ? "move" : "pointer") + '">';
      html += '<rect class="fp-room-rect" x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" fill="' + (isSelected ? "#dbeafe" : color) + '" stroke="' + (isSelected ? "#2563eb" : border) + '" stroke-width="' + (isSelected ? 3 : 2) + '" rx="2"/>';

      var cx = rx + rw / 2;
      var cy = ry + rh / 2;
      html += '<text x="' + cx + '" y="' + (cy - subFontSize * 0.3) + '" text-anchor="middle" font-size="' + fontSize + '" font-weight="600" fill="#374151" pointer-events="none">' + escHtml(room.name) + '</text>';
      html += '<text x="' + cx + '" y="' + (cy + fontSize * 0.7) + '" text-anchor="middle" font-size="' + subFontSize + '" fill="#6b7280" pointer-events="none">' + room.width + "' x " + room.height + "' (" + sqft + ' sf)</text>';

      // Features
      var features = room.features || [];
      if (features.length > 0 && rh > 50) {
        var iconStr = features.slice(0, 4).map(function(f) {
          var icons = { window:"▫", door:"🚪", fireplace:"🔥", island:"◻", shower:"🚿", tub:"🚿", toilet:"🚽", sink:"🚰", "washer/dryer":"🧺", closet:"🗄" };
          return icons[f] || "";
        }).filter(Boolean).join(" ");
        if (iconStr) html += '<text x="' + cx + '" y="' + (cy + fontSize * 1.6) + '" text-anchor="middle" font-size="' + Math.max(8, subFontSize) + '" pointer-events="none">' + iconStr + '</text>';
      }

      // Resize handles when selected in edit mode
      if (isSelected) {
        var hs = 8; // handle size
        // East edge (right)
        html += '<rect class="fp-handle" data-handle="resize-e" x="' + (rx + rw - hs / 2) + '" y="' + (ry + rh / 2 - hs) + '" width="' + hs + '" height="' + (hs * 2) + '" fill="#2563eb" rx="2" style="cursor:e-resize"/>';
        // South edge (bottom)
        html += '<rect class="fp-handle" data-handle="resize-s" x="' + (rx + rw / 2 - hs) + '" y="' + (ry + rh - hs / 2) + '" width="' + (hs * 2) + '" height="' + hs + '" fill="#2563eb" rx="2" style="cursor:s-resize"/>';
        // SE corner
        html += '<rect class="fp-handle" data-handle="resize-se" x="' + (rx + rw - hs) + '" y="' + (ry + rh - hs) + '" width="' + hs + '" height="' + hs + '" fill="#1d4ed8" rx="2" style="cursor:se-resize"/>';
        // West edge (left)
        html += '<rect class="fp-handle" data-handle="resize-w" x="' + (rx - hs / 2) + '" y="' + (ry + rh / 2 - hs) + '" width="' + hs + '" height="' + (hs * 2) + '" fill="#2563eb" rx="2" style="cursor:w-resize"/>';
        // North edge (top)
        html += '<rect class="fp-handle" data-handle="resize-n" x="' + (rx + rw / 2 - hs) + '" y="' + (ry - hs / 2) + '" width="' + (hs * 2) + '" height="' + hs + '" fill="#2563eb" rx="2" style="cursor:n-resize"/>';
      }
      html += '</g>';
    });

    // Doors (only in view mode — they get messy during edits)
    if (!fpEditMode) {
      (fp.doors || []).forEach(function(door) {
        var dx = fpPadding + door.x * fpScale;
        var dy = fpPadding + door.y * fpScale;
        var isH = door.orientation === "horizontal";
        var doorW = isH ? 16 : 4;
        var doorH = isH ? 4 : 16;
        var dColor = door.type === "entry" ? "#1a3c6e" : door.type === "garage" ? "#6b7280" : door.type === "sliding" ? "#0891b2" : "#92400e";
        html += '<rect x="' + (dx - doorW / 2) + '" y="' + (dy - doorH / 2) + '" width="' + doorW + '" height="' + doorH + '" fill="' + dColor + '" rx="1"/>';
      });
    }

    // Compass + scale bar
    html += '<text x="' + (svgW - 20) + '" y="25" text-anchor="middle" font-size="12" font-weight="700" fill="#6b7280">N</text>';
    html += '<text x="' + (svgW - 20) + '" y="35" text-anchor="middle" font-size="9" fill="#9ca3af">▲</text>';
    var sbFt = 10, sbPx = sbFt * fpScale;
    html += '<line x1="' + fpPadding + '" y1="' + (svgH - 8) + '" x2="' + (fpPadding + sbPx) + '" y2="' + (svgH - 8) + '" stroke="#6b7280" stroke-width="2"/>';
    html += '<text x="' + (fpPadding + sbPx / 2) + '" y="' + (svgH - 12) + '" text-anchor="middle" font-size="9" fill="#6b7280">' + sbFt + ' ft</text>';

    // Total sqft counter
    var totalSf = rooms.reduce(function(s, r) { return s + Math.round(r.width * r.height); }, 0);
    html += '<text x="' + (svgW - 10) + '" y="' + (svgH - 8) + '" text-anchor="end" font-size="9" fill="#6b7280">' + totalSf + ' sf total</text>';

    svg.innerHTML = html;
    attachFloorPlanEvents();
  }

  function attachFloorPlanEvents() {
    var svg = document.getElementById("floorplan-svg");
    var tooltip = document.getElementById("floorplan-tooltip");

    svg.querySelectorAll(".fp-room").forEach(function(g) {
      var rid = g.dataset.roomId;

      // Hover tooltip (both modes)
      g.addEventListener("mouseenter", function() {
        if (fpDrag) return;
        var room = findFpRoom(rid);
        if (!room) return;
        var sqft = Math.round(room.width * room.height);
        var feats = (room.features || []).join(", ") || "None";
        tooltip.innerHTML = "<strong>" + escHtml(room.name) + "</strong><br>" + room.width + "' × " + room.height + "' = " + sqft + " sf<br>Features: " + feats;
        tooltip.style.display = "block";
        if (!fpEditMode) {
          var rect = g.querySelector(".fp-room-rect");
          if (rect) rect.setAttribute("fill", "#dbeafe");
        }
      });
      g.addEventListener("mousemove", function(e) {
        if (fpDrag) return;
        var cr = document.getElementById("floorplan-container").getBoundingClientRect();
        tooltip.style.left = (e.clientX - cr.left + 12) + "px";
        tooltip.style.top = (e.clientY - cr.top - 10) + "px";
      });
      g.addEventListener("mouseleave", function() {
        tooltip.style.display = "none";
        if (!fpEditMode) {
          var room = findFpRoom(rid);
          var rect = g.querySelector(".fp-room-rect");
          if (rect && room) rect.setAttribute("fill", ROOM_COLORS[room.type] || "#f3f4f6");
        }
      });

      // Edit mode: click to select, drag when already selected
      if (fpEditMode) {
        g.addEventListener("mousedown", function(e) {
          if (e.target.classList.contains("fp-handle")) return;
          e.preventDefault();
          tooltip.style.display = "none";
          var room = findFpRoom(rid);
          if (!room) return;

          if (fpSelectedRoom !== rid) {
            fpSelectedRoom = rid;
            drawFloorPlan(); // redraw to show handles
          } else {
            fpDrag = { type: "move", roomId: rid, startX: e.clientX, startY: e.clientY, origX: room.x, origY: room.y, origW: room.width, origH: room.height, el: g };
          }
        });

        // Double-click to rename
        g.addEventListener("dblclick", function(e) {
          e.preventDefault();
          var room = findFpRoom(rid);
          if (!room) return;
          var newName = prompt("Room name:", room.name);
          if (newName !== null && newName.trim()) {
            room.name = newName.trim();
            fpDirty = true;
            updateEditStatus();
            drawFloorPlan();
          }
        });
      }
    });

    // Resize handles
    if (fpEditMode) {
      svg.querySelectorAll(".fp-handle").forEach(function(h) {
        h.addEventListener("mousedown", function(e) {
          e.preventDefault();
          e.stopPropagation();
          var handleType = h.dataset.handle;
          var room = findFpRoom(fpSelectedRoom);
          if (!room) return;
          fpDrag = { type: handleType, roomId: fpSelectedRoom, startX: e.clientX, startY: e.clientY, origX: room.x, origY: room.y, origW: room.width, origH: room.height };
        });
      });

      // Click background to deselect
      svg.addEventListener("mousedown", function(e) {
        if (e.target === svg || e.target.tagName === "line" || (e.target.tagName === "rect" && !e.target.closest(".fp-room") && !e.target.classList.contains("fp-handle"))) {
          fpSelectedRoom = null;
          drawFloorPlan();
        }
      });
    }
  }

  // Global mouse handlers for drag — translate during move, throttled redraw for resize
  document.addEventListener("mousemove", function(e) {
    if (!fpDrag || !currentFloorPlan) return;
    var room = findFpRoom(fpDrag.roomId);
    if (!room) return;
    var dx = (e.clientX - fpDrag.startX) / (fpScale * fpZoom);
    var dy = (e.clientY - fpDrag.startY) / (fpScale * fpZoom);

    if (fpDrag.type === "move") {
      room.x = snapFt(Math.max(0, fpDrag.origX + dx));
      room.y = snapFt(Math.max(0, fpDrag.origY + dy));
      if (fpDrag.el) {
        var tdx = (room.x - fpDrag.origX) * fpScale;
        var tdy = (room.y - fpDrag.origY) * fpScale;
        fpDrag.el.setAttribute("transform", "translate(" + tdx + "," + tdy + ")");
      }
    } else {
      if (fpDrag.type === "resize-e") { room.width = snapFt(Math.max(3, fpDrag.origW + dx)); }
      else if (fpDrag.type === "resize-s") { room.height = snapFt(Math.max(3, fpDrag.origH + dy)); }
      else if (fpDrag.type === "resize-se") { room.width = snapFt(Math.max(3, fpDrag.origW + dx)); room.height = snapFt(Math.max(3, fpDrag.origH + dy)); }
      else if (fpDrag.type === "resize-w") { var newX = snapFt(fpDrag.origX + dx); var newW = fpDrag.origW + (fpDrag.origX - newX); if (newW >= 3) { room.x = newX; room.width = newW; } }
      else if (fpDrag.type === "resize-n") { var newY = snapFt(fpDrag.origY + dy); var newH = fpDrag.origH + (fpDrag.origY - newY); if (newH >= 3) { room.y = newY; room.height = newH; } }
      if (!fpDrag._raf) {
        fpDrag._raf = requestAnimationFrame(function() { fpDrag._raf = null; drawFloorPlan(); });
      }
    }
    fpDirty = true;
  });

  document.addEventListener("mouseup", function() {
    if (fpDrag) {
      fpDrag = null;
      updateEditStatus();
      drawFloorPlan(); // full redraw to finalize position
    }
  });

  function findFpRoom(id) {
    if (!currentFloorPlan) return null;
    return currentFloorPlan.rooms.find(function(r) { return r.id === id; });
  }

  function setEditUI(isOn) {
    fpEditMode = isOn;
    var toolbar = document.getElementById("fp-edit-toolbar");
    var toggleBtn = document.getElementById("fp-toggle-edit");
    if (toolbar) toolbar.style.display = isOn ? "flex" : "none";
    if (toggleBtn) { toggleBtn.textContent = isOn ? "View" : "Edit"; toggleBtn.style.color = isOn ? "#2563eb" : ""; }
    ["fp-add-room","fp-delete-room","fp-save-plan"].forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = isOn ? "" : "none"; });
    if (!isOn) { var ap = document.getElementById("fp-add-panel"); if (ap) ap.style.display = "none"; }
  }

  function updateEditStatus() {
    document.getElementById("fp-edit-status").textContent = fpDirty ? "Unsaved changes" : "All saved";
    document.getElementById("fp-edit-status").style.color = fpDirty ? "#dc2626" : "#059669";
  }

  // Toggle edit mode
  on("fp-toggle-edit", "click", function() {
    if (!currentFloorPlan) return;
    fpEditMode = !fpEditMode;
    fpSelectedRoom = null;
    setEditUI(fpEditMode);
    drawFloorPlan();
  });

  // Zoom
  on("fp-zoom-in", "click", function() {
    fpZoom = Math.min(fpZoom + 0.25, 3);
    if (currentFloorPlan) drawFloorPlan();
  });
  on("fp-zoom-out", "click", function() {
    fpZoom = Math.max(fpZoom - 0.25, 0.5);
    if (currentFloorPlan) drawFloorPlan();
  });
  on("fp-floor-select", "change", function(e) {
    fpCurrentFloor = parseInt(e.target.value);
    fpSelectedRoom = null;
    if (currentFloorPlan) drawFloorPlan();
  });

  // Add room
  on("fp-add-room", "click", function() {
    var panel = document.getElementById("fp-add-panel");
    panel.style.display = panel.style.display === "none" ? "" : "none";
  });
  on("fp-add-cancel", "click", function() {
    document.getElementById("fp-add-panel").style.display = "none";
  });
  on("fp-add-confirm", "click", function() {
    if (!currentFloorPlan) return;
    var name = document.getElementById("fp-new-name").value.trim() || "New Room";
    var type = document.getElementById("fp-new-type").value;
    var w = parseInt(document.getElementById("fp-new-w").value) || 12;
    var h = parseInt(document.getElementById("fp-new-h").value) || 12;

    // Place at first available spot (simple: offset from last room)
    var rooms = currentFloorPlan.rooms.filter(function(r) { return (r.floor || 1) === fpCurrentFloor; });
    var maxX = 0, maxY = 0;
    rooms.forEach(function(r) { if (r.x + r.width > maxX) { maxX = r.x + r.width; maxY = r.y; } });

    var newRoom = {
      id: "room-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      name: name, type: type, floor: fpCurrentFloor,
      x: maxX + 1, y: maxY, width: w, height: h, features: []
    };
    currentFloorPlan.rooms.push(newRoom);
    fpSelectedRoom = newRoom.id;
    fpDirty = true;
    updateEditStatus();
    document.getElementById("fp-add-panel").style.display = "none";
    drawFloorPlan();
    showToast("Room added — drag to position", "success");
  });

  // Delete selected room
  on("fp-delete-room", "click", function() {
    if (!currentFloorPlan || !fpSelectedRoom) { showToast("Select a room first", "error"); return; }
    var room = findFpRoom(fpSelectedRoom);
    if (!room) return;
    if (!confirm('Delete "' + room.name + '"?')) return;
    currentFloorPlan.rooms = currentFloorPlan.rooms.filter(function(r) { return r.id !== fpSelectedRoom; });
    fpSelectedRoom = null;
    fpDirty = true;
    updateEditStatus();
    drawFloorPlan();
    showToast("Room deleted", "success");
  });

  // Keyboard: Delete/Backspace to remove selected room, Escape to deselect
  document.addEventListener("keydown", function(e) {
    if (!fpEditMode || !currentFloorPlan) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    if ((e.key === "Delete" || e.key === "Backspace") && fpSelectedRoom) {
      document.getElementById("fp-delete-room").click();
    }
    if (e.key === "Escape") {
      fpSelectedRoom = null;
      drawFloorPlan();
    }
  });

  // Save floor plan
  on("fp-save-plan", "click", async function() {
    if (!currentDealId || !currentFloorPlan) return;
    var btn = document.getElementById("fp-save-plan");
    btn.disabled = true; btn.textContent = "Saving...";
    try {
      await db.collection("deal-analyzer").doc(currentDealId).update({
        floorPlan: currentFloorPlan,
        updatedAt: new Date().toISOString()
      });
      var deal = allDeals.find(function(d) { return d.id === currentDealId; });
      if (deal) deal.floorPlan = JSON.parse(JSON.stringify(currentFloorPlan));
      fpDirty = false;
      updateEditStatus();
      showToast("Floor plan saved", "success");
    } catch (err) {
      showToast("Failed to save", "error");
    } finally {
      btn.disabled = false; btn.textContent = "Save";
    }
  });

  // Generate floor plan
  on("btn-generate-floorplan", "click", async function() {
    if (!currentDealId) return;
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (!deal) return;
    if (deal.floorPlan && deal.floorPlan.rooms && deal.floorPlan.rooms.length) {
      if (!confirm("This will replace the existing floor plan. Continue?")) return;
    }
    var btn = document.getElementById("btn-generate-floorplan");
    var loading = document.getElementById("floorplan-loading");
    btn.disabled = true; btn.textContent = "Generating...";
    loading.style.display = "flex";
    try {
      var token = await currentUser.getIdToken();
      var res = await fetch(FUNCTIONS_BASE + "/generateFloorPlan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ property: deal.property })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      deal.floorPlan = data.floorPlan;
      await db.collection("deal-analyzer").doc(currentDealId).update({
        floorPlan: data.floorPlan, updatedAt: new Date().toISOString()
      });
      renderDealFloorPlan(deal);
      showToast("Floor plan generated — click Edit to customize", "success");
    } catch (err) {
      console.error("Floor plan error:", err);
      showToast("Failed to generate floor plan: " + err.message, "error");
    } finally {
      btn.disabled = false; btn.textContent = "Generate Floor Plan";
      loading.style.display = "none";
    }
  });

  // ===== LIFECYCLE: ACTIVITY LOG =====
  var ACTIVITY_CATS = { general:"General", financial:"Financial", contractor:"Contractor", lender:"Lender", tenant:"Tenant", legal:"Legal" };

  function renderDealActivity(deal) {
    var log = (deal.activityLog || []).slice().sort(function(a, b) { return (b.date || "").localeCompare(a.date || ""); });
    var container = document.getElementById("deal-activity-list");
    if (!log.length) { container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">No activity yet. Add your first note.</p>'; return; }
    container.innerHTML = log.map(function(entry) {
      var d = entry.date ? new Date(entry.date).toLocaleString("en-US", { month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" }) : "";
      return '<div style="padding:0.6rem 0;border-bottom:1px solid #f3f4f6"><div style="display:flex;justify-content:space-between;align-items:center"><div><span class="activity-badge cat-' + (entry.category || "general") + '">' + (ACTIVITY_CATS[entry.category] || "General") + '</span><span style="font-size:0.75rem;color:#9ca3af;margin-left:0.5rem">' + d + '</span></div><button class="btn btn-secondary btn-sm" style="padding:0.1rem 0.4rem;font-size:0.65rem" data-note-id="' + entry.id + '">&times;</button></div><p style="font-size:0.85rem;margin-top:0.3rem;line-height:1.5">' + escHtml(entry.text || "") + '</p></div>';
    }).join("");
    container.querySelectorAll("[data-note-id]").forEach(function(btn) {
      btn.addEventListener("click", function() { removeActivity(btn.dataset.noteId); });
    });
  }

  on("btn-add-activity", "click", function() {
    var form = document.getElementById("deal-activity-form");
    form.style.display = form.style.display === "none" ? "" : "none";
  });

  on("btn-save-activity", "click", async function() {
    var text = document.getElementById("activity-text").value.trim();
    if (!text) { showToast("Note text is required", "error"); return; }
    var entry = { id: uid(), date: new Date().toISOString(), category: document.getElementById("activity-category").value, text: text };
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (deal) { if (!deal.activityLog) deal.activityLog = []; deal.activityLog.push(entry); }
    try {
      await db.collection("deal-analyzer").doc(currentDealId).update({
        activityLog: firebase.firestore.FieldValue.arrayUnion(entry),
        updatedAt: new Date().toISOString()
      });
      document.getElementById("activity-text").value = "";
      document.getElementById("deal-activity-form").style.display = "none";
      renderDealActivity(deal);
      showToast("Note added", "success");
    } catch (err) { showToast("Failed to save note", "error"); }
  });

  async function removeActivity(noteId) {
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (!deal) return;
    deal.activityLog = (deal.activityLog || []).filter(function(n) { return n.id !== noteId; });
    try {
      await db.collection("deal-analyzer").doc(currentDealId).update({ activityLog: deal.activityLog, updatedAt: new Date().toISOString() });
      renderDealActivity(deal);
    } catch (err) { showToast("Failed to remove", "error"); }
  }

  // ===== LIFECYCLE: CONTACTS =====
  var CONTACT_ROLES = { lender:"Lender", contractor:"Contractor", inspector:"Inspector", appraiser:"Appraiser", title:"Title Co.", insurance:"Insurance", "property-manager":"Prop. Mgmt", tenant:"Tenant", seller:"Seller", attorney:"Attorney", realtor:"Realtor" };

  function renderDealContacts(deal) {
    var contacts = deal.contacts || [];
    var container = document.getElementById("deal-contacts-list");
    if (!contacts.length) { container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">No contacts yet.</p>'; return; }
    container.innerHTML = contacts.map(function(c) {
      var links = [];
      if (c.phone) links.push('<a href="tel:' + escHtml(c.phone) + '">' + escHtml(c.phone) + '</a>');
      if (c.email) links.push('<a href="mailto:' + escHtml(c.email) + '">' + escHtml(c.email) + '</a>');
      return '<div style="padding:0.65rem 0;border-bottom:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:flex-start"><div><span class="contact-role">' + (CONTACT_ROLES[c.role] || c.role) + '</span> <strong style="margin-left:0.4rem">' + escHtml(c.name || "") + '</strong>' + (c.company ? ' <span style="color:#9ca3af;font-size:0.8rem">— ' + escHtml(c.company) + '</span>' : '') + (links.length ? '<div style="font-size:0.8rem;margin-top:0.25rem">' + links.join(' &nbsp;|&nbsp; ') + '</div>' : '') + (c.notes ? '<p style="font-size:0.8rem;color:#6b7280;margin-top:0.2rem">' + escHtml(c.notes) + '</p>' : '') + '</div><button class="btn btn-secondary btn-sm" style="padding:0.1rem 0.4rem;font-size:0.65rem" data-contact-id="' + c.id + '">&times;</button></div>';
    }).join("");
    container.querySelectorAll("[data-contact-id]").forEach(function(btn) {
      btn.addEventListener("click", function() { removeContact(btn.dataset.contactId); });
    });
  }

  on("btn-add-contact", "click", function() {
    var form = document.getElementById("deal-contact-form");
    form.style.display = form.style.display === "none" ? "" : "none";
  });

  on("btn-save-contact", "click", async function() {
    var name = document.getElementById("contact-name").value.trim();
    if (!name) { showToast("Contact name required", "error"); return; }
    var contact = { id: uid(), role: document.getElementById("contact-role").value, name: name, phone: document.getElementById("contact-phone").value.trim(), email: document.getElementById("contact-email").value.trim(), company: document.getElementById("contact-company").value.trim(), notes: document.getElementById("contact-notes").value.trim() };
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (deal) { if (!deal.contacts) deal.contacts = []; deal.contacts.push(contact); }
    try {
      await db.collection("deal-analyzer").doc(currentDealId).update({
        contacts: firebase.firestore.FieldValue.arrayUnion(contact),
        updatedAt: new Date().toISOString()
      });
      ["contact-name","contact-phone","contact-email","contact-company","contact-notes"].forEach(function(id) { document.getElementById(id).value = ""; });
      document.getElementById("deal-contact-form").style.display = "none";
      renderDealContacts(deal);
      showToast("Contact added", "success");
    } catch (err) { showToast("Failed to save contact", "error"); }
  });

  async function removeContact(contactId) {
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (!deal) return;
    deal.contacts = (deal.contacts || []).filter(function(c) { return c.id !== contactId; });
    try {
      await db.collection("deal-analyzer").doc(currentDealId).update({ contacts: deal.contacts, updatedAt: new Date().toISOString() });
      renderDealContacts(deal);
    } catch (err) { showToast("Failed to remove", "error"); }
  }

  // ===== LIFECYCLE: DOCUMENTS =====
  var DOC_CATS = { contract:"Contract", insurance:"Insurance", appraisal:"Appraisal", inspection:"Inspection", photos:"Photos", title:"Title", "loan-docs":"Loan Docs", permits:"Permits", receipts:"Receipts", other:"Other" };

  function renderDealDocuments(deal) {
    var docs = deal.documents || [];
    var tbody = document.getElementById("deal-documents-tbody");
    if (!tbody) return;
    if (!docs.length) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#9ca3af;font-size:0.85rem;padding:1rem">No documents yet.</td></tr>'; return; }
    tbody.innerHTML = docs.map(function(doc) {
      var date = doc.dateAdded ? new Date(doc.dateAdded).toLocaleDateString() : "—";
      return '<tr><td><a href="' + escHtml(doc.url || "#") + '" target="_blank" rel="noopener" style="font-weight:600">' + escHtml(doc.name || "Untitled") + '</a></td><td><span class="doc-cat">' + (DOC_CATS[doc.category] || doc.category) + '</span></td><td>' + date + '</td><td><button class="btn btn-secondary btn-sm" style="padding:0.1rem 0.4rem;font-size:0.65rem" data-doc-id="' + doc.id + '">&times;</button></td></tr>';
    }).join("");
    tbody.querySelectorAll("[data-doc-id]").forEach(function(btn) {
      btn.addEventListener("click", function() { removeDocument(btn.dataset.docId); });
    });
  }

  on("btn-add-document", "click", function() {
    var form = document.getElementById("deal-document-form");
    form.style.display = form.style.display === "none" ? "" : "none";
  });

  on("btn-save-document", "click", async function() {
    var name = document.getElementById("doc-name").value.trim();
    var url = document.getElementById("doc-url").value.trim();
    if (!name || !url) { showToast("Document name and URL required", "error"); return; }
    var doc = { id: uid(), name: name, url: url, category: document.getElementById("doc-category").value, dateAdded: new Date().toISOString() };
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (deal) { if (!deal.documents) deal.documents = []; deal.documents.push(doc); }
    try {
      await db.collection("deal-analyzer").doc(currentDealId).update({
        documents: firebase.firestore.FieldValue.arrayUnion(doc),
        updatedAt: new Date().toISOString()
      });
      document.getElementById("doc-name").value = "";
      document.getElementById("doc-url").value = "";
      document.getElementById("deal-document-form").style.display = "none";
      renderDealDocuments(deal);
      showToast("Document added", "success");
    } catch (err) { showToast("Failed to save document", "error"); }
  });

  async function removeDocument(docId) {
    var deal = allDeals.find(function(d) { return d.id === currentDealId; });
    if (!deal) return;
    deal.documents = (deal.documents || []).filter(function(d) { return d.id !== docId; });
    try {
      await db.collection("deal-analyzer").doc(currentDealId).update({ documents: deal.documents, updatedAt: new Date().toISOString() });
      renderDealDocuments(deal);
    } catch (err) { showToast("Failed to remove", "error"); }
  }

  // Helper to read checklist item (handles both legacy boolean and new {checked, notes} format)
  function getCheckItem(checks, key) {
    const val = checks[key];
    if (val === true || val === false) return { checked: val, notes: "" };
    if (val && typeof val === "object") return { checked: !!val.checked, notes: val.notes || "" };
    return { checked: false, notes: "" };
  }

  function renderDealChecklists(deal) {
    document.querySelectorAll(".deal-phase-tab").forEach(tab => {
      tab.classList.toggle("active", tab.dataset.phase === currentPhase);
    });

    const container = document.getElementById("deal-checklist-items");
    const labels = CHECKLIST_LABELS[currentPhase] || {};
    const checks = (deal.checklists && deal.checklists[currentPhase]) || {};

    container.innerHTML = Object.entries(labels).map(([key, label]) => {
      const item = getCheckItem(checks, key);
      return `<div class="deal-checklist-item ${item.checked ? "checked" : ""}" data-key="${key}">
        <input type="checkbox" data-phase="${currentPhase}" data-key="${key}" ${item.checked ? "checked" : ""} />
        <div style="flex:1">
          <label>${label}</label>
          <div class="checklist-note-toggle" data-key="${key}" style="font-size:0.75rem;color:var(--accent,#1a3c6e);cursor:pointer;margin-top:0.15rem">${item.notes ? "Edit note" : "+ Add note"}</div>
          <div class="checklist-note-area" data-key="${key}" style="display:${item.notes ? "block" : "none"};margin-top:0.4rem">
            <textarea data-phase="${currentPhase}" data-key="${key}" rows="2" placeholder="Add details, links, contacts..." style="width:100%;font-size:0.8rem;padding:0.4rem 0.5rem;border:1px solid var(--border,#e5e7eb);border-radius:4px;font-family:inherit;resize:vertical">${escHtml(item.notes)}</textarea>
          </div>
        </div>
      </div>`;
    }).join("");

    // Wire checkbox events
    container.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", async () => {
        const phase = cb.dataset.phase;
        const key = cb.dataset.key;
        const val = cb.checked;
        cb.closest(".deal-checklist-item").classList.toggle("checked", val);

        const deal = allDeals.find(d => d.id === currentDealId);
        if (deal) {
          if (!deal.checklists) deal.checklists = {};
          if (!deal.checklists[phase]) deal.checklists[phase] = {};
          const existing = getCheckItem(deal.checklists[phase], key);
          deal.checklists[phase][key] = { checked: val, notes: existing.notes };
        }

        try {
          await db.collection("deal-analyzer").doc(currentDealId).update({
            [`checklists.${phase}.${key}.checked`]: val,
            updatedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error("Checklist update error:", err);
          showToast("Failed to save checklist", "error");
        }
        updateChecklistProgress();
      });
    });

    // Wire note toggles
    container.querySelectorAll(".checklist-note-toggle").forEach(toggle => {
      toggle.addEventListener("click", () => {
        const key = toggle.dataset.key;
        const area = container.querySelector(`.checklist-note-area[data-key="${key}"]`);
        if (area) {
          const visible = area.style.display !== "none";
          area.style.display = visible ? "none" : "block";
          if (!visible) area.querySelector("textarea").focus();
        }
      });
    });

    // Wire note save (on blur)
    container.querySelectorAll(".checklist-note-area textarea").forEach(ta => {
      ta.addEventListener("blur", async () => {
        const phase = ta.dataset.phase;
        const key = ta.dataset.key;
        const notes = ta.value.trim();

        const deal = allDeals.find(d => d.id === currentDealId);
        if (deal) {
          if (!deal.checklists) deal.checklists = {};
          if (!deal.checklists[phase]) deal.checklists[phase] = {};
          const existing = getCheckItem(deal.checklists[phase], key);
          deal.checklists[phase][key] = { checked: existing.checked, notes };
        }

        // Update toggle text
        const toggle = container.querySelector(`.checklist-note-toggle[data-key="${key}"]`);
        if (toggle) toggle.textContent = notes ? "Edit note" : "+ Add note";

        try {
          await db.collection("deal-analyzer").doc(currentDealId).update({
            [`checklists.${phase}.${key}.notes`]: notes,
            updatedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error("Note save error:", err);
        }
      });
    });

    updateChecklistProgress();
  }

  function updateChecklistProgress() {
    const deal = allDeals.find(d => d.id === currentDealId);
    if (!deal) return;
    let total = 0, done = 0;
    Object.values(CHECKLIST_LABELS).forEach(phase => {
      Object.keys(phase).forEach(() => { total++; });
    });
    Object.entries(deal.checklists || {}).forEach(([, items]) => {
      Object.entries(items).forEach(([, v]) => {
        const checked = v === true || (v && v.checked === true);
        if (checked) done++;
      });
    });
    const el = document.getElementById("deal-checklist-progress");
    if (el) el.textContent = `${done} / ${total} complete`;
  }

  // Phase tab switching
  on("deal-phase-tabs", "click", (e) => {
    const tab = e.target.closest(".deal-phase-tab");
    if (!tab) return;
    currentPhase = tab.dataset.phase;
    const deal = allDeals.find(d => d.id === currentDealId);
    if (deal) renderDealChecklists(deal);
  });

  // Status update
  on("deal-detail-status", "change", async (e) => {
    const newStatus = e.target.value;
    if (!currentDealId) return;
    try {
      var updates = { status: newStatus, updatedAt: new Date().toISOString() };
      const deal = allDeals.find(d => d.id === currentDealId);

      // Prompt for earnest money when moving to under-contract
      if (newStatus === "under-contract" && deal) {
        var existingEarnest = ((deal.financials || {}).loanTerms || {}).earnestMoney;
        if (!existingEarnest) {
          var earnest = prompt("Earnest money deposit amount ($):", "1000");
          if (earnest !== null && parseInt(earnest) > 0) {
            var earnestVal = parseInt(earnest);
            updates["financials.loanTerms.earnestMoney"] = earnestVal;
            if (!deal.financials) deal.financials = {};
            if (!deal.financials.loanTerms) deal.financials.loanTerms = {};
            deal.financials.loanTerms.earnestMoney = earnestVal;
          }
        }
      }

      await db.collection("deal-analyzer").doc(currentDealId).update(updates);
      if (deal) deal.status = newStatus;
      renderDealActuals(deal);
      showToast("Status updated", "success");
    } catch (err) {
      showToast("Failed to update status", "error");
    }
  });

  // Re-analyze
  on("btn-reanalyze", "click", async () => {
    const deal = allDeals.find(d => d.id === currentDealId);
    if (!deal) return;
    const btn = document.getElementById("btn-reanalyze");
    btn.disabled = true;
    btn.textContent = "Analyzing...";
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${FUNCTIONS_BASE}/analyzeDeal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ property: deal.property, dealId: currentDealId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-analysis failed");

      deal.analysis = data.analysis;
      renderDealResults(deal);
      showToast("Deal re-analyzed", "success");
    } catch (err) {
      showToast(err.message || "Re-analysis failed", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Re-analyze";
    }
  });

  // Delete deal
  on("btn-delete-deal", "click", async () => {
    if (!currentDealId || !confirm("Delete this deal? This cannot be undone.")) return;
    try {
      await db.collection("deal-analyzer").doc(currentDealId).delete();
      allDeals = allDeals.filter(d => d.id !== currentDealId);
      showToast("Deal deleted", "success");
      showDealsList();
      renderDealsTable();
    } catch (err) {
      showToast("Failed to delete deal", "error");
    }
  });

  // Filters
  ["deal-filter-status", "deal-filter-strategy", "deal-filter-search"].forEach(function(id) {
    on(id, "input", renderDealsTable);
    on(id, "change", renderDealsTable);
  });

  // ===== PROPERTY MANAGEMENT =====
  var pmCurrentId = null;
  var pmFpZoom = 1;
  var pmFpFloor = 1;
  var PM_OWNED = ["closing", "rehab", "exit", "complete"];
  var PM_CAT_LABELS = { appliance:"Appliance", fixture:"Fixture", furniture:"Furniture", material:"Material", repair:"Repair", upgrade:"Upgrade", maintenance:"Maintenance", other:"Other" };
  var PM_MAINT_LABELS = { preventive:"Preventive", repair:"Repair", inspection:"Inspection", emergency:"Emergency", seasonal:"Seasonal", "tenant-request":"Tenant Request" };

  function getOwnedProperties() {
    return allDeals.filter(function(d) {
      return PM_OWNED.indexOf(d.status) !== -1
        || (d.floorPlan && d.floorPlan.rooms && d.floorPlan.rooms.length > 0)
        || (d.propertyMgmt && d.propertyMgmt.managed);
    });
  }

  function renderPropertyList() {
    var props = getOwnedProperties();
    var statusFilter = document.getElementById("pm-filter-status").value;
    var search = (document.getElementById("pm-filter-search").value || "").toLowerCase();
    if (statusFilter) props = props.filter(function(d) { return d.status === statusFilter; });
    if (search) props = props.filter(function(d) { var p = d.property || {}; return ((p.address || "") + " " + (p.city || "")).toLowerCase().includes(search); });

    // Stats
    var allOwned = getOwnedProperties();
    var totalItems = 0, totalItemsCost = 0, totalMaint = 0;
    allOwned.forEach(function(d) {
      var pm = d.propertyMgmt || {};
      totalItems += (pm.items || []).length;
      totalItemsCost += (pm.items || []).reduce(function(s, i) { return s + (i.cost || 0); }, 0);
      totalMaint += (pm.maintenance || []).length;
    });
    document.getElementById("pm-stats").innerHTML = [
      { label: "Owned Properties", value: allOwned.length, style: "color:#1a3c6e" },
      { label: "Total Items Tracked", value: totalItems, style: "" },
      { label: "Items Spending", value: fmtDealDollar(totalItemsCost), style: totalItemsCost > 0 ? "color:#dc2626" : "" },
      { label: "Maintenance Logs", value: totalMaint, style: "" }
    ].map(function(c) {
      return '<div class="stat-card"><div class="stat-card-label">' + c.label + '</div><div class="stat-card-value" style="' + c.style + '">' + c.value + '</div></div>';
    }).join("");

    // Table
    var tbody = document.getElementById("pm-table-body");
    var empty = document.getElementById("pm-empty");
    if (!props.length) { tbody.innerHTML = ""; empty.style.display = "block"; return; }
    empty.style.display = "none";

    tbody.innerHTML = props.map(function(d) {
      var p = d.property || {};
      var fin = d.financials || {};
      var lt = fin.loanTerms || {};
      var pm = d.propertyMgmt || {};
      var itemCount = (pm.items || []).length + (pm.maintenance || []).length;
      var purchase = fin.actualPurchasePrice || p.purchasePrice || 0;
      var closing = fin.actualClosingCosts || 0;
      var rehab = (fin.rehabLineItems || []).reduce(function(s, i) { return s + (i.amount || 0); }, 0);
      var invested = lt.downPayment > 0 ? lt.downPayment + closing + rehab : purchase + closing + rehab;
      var arv = fin.actualArv || p.arv || 0;
      var equity = arv - (purchase + closing + rehab);
      var exp = fin.monthlyExpenses || {};
      var totalExp = Object.values(exp).reduce(function(s, v) { return s + (parseFloat(v) || 0); }, 0);
      var cf = (p.monthlyRent || 0) - totalExp;

      return '<tr style="cursor:pointer" data-pm-id="' + d.id + '">' +
        '<td><strong>' + escHtml(p.address || "—") + '</strong><br><span style="font-size:0.75rem;color:var(--text-muted)">' + escHtml((p.city || "") + (p.state ? ", " + p.state : "")) + '</span></td>' +
        '<td>' + (STRATEGY_LABELS[p.strategy] || p.strategy || "—") + '</td>' +
        '<td><span class="status-badge badge-' + (d.status || "closing") + '">' + (STATUS_LABELS[d.status] || d.status || "—") + '</span></td>' +
        '<td>' + fmtDealDollar(invested) + '</td>' +
        '<td style="' + (equity > 0 ? "color:#059669" : "color:#dc2626") + '">' + fmtDealDollar(equity) + '</td>' +
        '<td style="' + (cf > 0 ? "color:#059669" : cf < 0 ? "color:#dc2626" : "") + '">' + (p.monthlyRent ? fmtDealDollar(cf) + '/mo' : "—") + '</td>' +
        '<td>' + itemCount + '</td>' +
        '<td><button class="btn btn-secondary btn-sm pm-del-prop" data-del-id="' + d.id + '" style="padding:0.15rem 0.4rem;font-size:0.65rem;color:#dc2626">&times;</button></td>' +
        '</tr>';
    }).join("");

    tbody.querySelectorAll("tr[data-pm-id]").forEach(function(row) {
      row.addEventListener("click", function(e) {
        if (e.target.closest(".pm-del-prop")) return;
        openPropertyDetail(row.dataset.pmId);
      });
    });

    tbody.querySelectorAll(".pm-del-prop").forEach(function(btn) {
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        deleteProperty(btn.dataset.delId);
      });
    });
  }

  function openPropertyDetail(id) {
    var deal = allDeals.find(function(d) { return d.id === id; });
    if (!deal) return;
    pmCurrentId = id;
    document.getElementById("pm-list-section").style.display = "none";
    document.getElementById("pm-detail-section").style.display = "";

    var p = deal.property || {};
    var a = deal.analysis || {};
    var score = a.dealScore || 0;

    // Header
    document.getElementById("pm-detail-address").textContent = (p.address || "Unknown") + (p.city ? ", " + p.city : "") + (p.state ? ", " + p.state : "");
    document.getElementById("pm-detail-subtitle").textContent = [STRATEGY_LABELS[p.strategy] || p.strategy, p.type, p.beds ? p.beds + " bed" : "", p.baths ? p.baths + " bath" : "", p.sqft ? p.sqft + " sqft" : ""].filter(Boolean).join(" · ");
    var badge = document.getElementById("pm-score-badge");
    badge.textContent = score || "?";
    badge.className = "deal-score-badge " + (score >= 7 ? "score-good" : score >= 4 ? "score-mid" : "score-bad");
    document.getElementById("pm-detail-badge").textContent = STATUS_LABELS[deal.status] || deal.status;
    document.getElementById("pm-detail-badge").className = "status-badge badge-" + (deal.status || "closing");

    // Map + house info + lot + floor plan
    renderPmMap(deal);
    renderPmHouseInfo(deal);
    renderPmLotInfo(deal);
    renderPmFloorPlan(deal);

    // Populate room dropdowns from floor plan
    populatePmRoomDropdowns(deal);

    // Items & maintenance
    renderPmItems(deal);
    renderPmMaintenance(deal);
  }

  on("pm-btn-back", "click", function() {
    document.getElementById("pm-detail-section").style.display = "none";
    document.getElementById("pm-list-section").style.display = "";
    clearTimeout(pmPropTimer); clearTimeout(pmLotTimer);
    pmCurrentId = null;
    renderPropertyList();
  });

  on("pm-btn-goto-deal", "click", function() {
    if (!pmCurrentId) return;
    // Switch to deal analyzer and open this deal
    document.querySelectorAll(".nav-item").forEach(function(n) { n.classList.remove("active"); });
    var dealNav = document.querySelector('.nav-item[data-view="deal-analyzer"]');
    if (dealNav) dealNav.classList.add("active");
    document.querySelectorAll(".view").forEach(function(v) { v.classList.remove("active"); });
    var dealView = document.getElementById("view-deal-analyzer");
    if (dealView) dealView.classList.add("active");
    document.getElementById("topbar-title").textContent = "Deal Analyzer";
    openDealDetail(pmCurrentId);
  });

  // Delete property with warning
  async function deleteProperty(id) {
    var deal = allDeals.find(function(d) { return d.id === id; });
    if (!deal) return;
    var p = deal.property || {};
    var pm = deal.propertyMgmt || {};
    var itemCount = (pm.items || []).length;
    var maintCount = (pm.maintenance || []).length;
    var hasFp = deal.floorPlan && deal.floorPlan.rooms && deal.floorPlan.rooms.length;

    var warnings = [];
    if (hasFp) warnings.push(deal.floorPlan.rooms.length + " rooms in floor plan");
    if (itemCount) warnings.push(itemCount + " tracked items");
    if (maintCount) warnings.push(maintCount + " maintenance logs");

    var msg = 'Delete "' + (p.address || "this property") + '"?\n\n';
    if (warnings.length) {
      msg += "This will permanently remove:\n- " + warnings.join("\n- ") + "\n\n";
    }
    msg += "This also removes the deal from Deal Analyzer. This cannot be undone.";

    if (!confirm(msg)) return;
    // Second confirmation for properties with data
    if (warnings.length && !confirm("Are you absolutely sure? All property data, items, and maintenance records will be lost.")) return;

    try {
      await db.collection("deal-analyzer").doc(id).delete();
      allDeals = allDeals.filter(function(d) { return d.id !== id; });
      if (pmCurrentId === id) {
        document.getElementById("pm-detail-section").style.display = "none";
        document.getElementById("pm-list-section").style.display = "";
        pmCurrentId = null;
      }
      renderPropertyList();
      showToast("Property deleted", "success");
    } catch (err) {
      showToast("Failed to delete property", "error");
    }
  }

  on("pm-btn-delete-prop", "click", function() {
    if (pmCurrentId) deleteProperty(pmCurrentId);
  });
  document.addEventListener("pm-delete-prop", function() { if (pmCurrentId) deleteProperty(pmCurrentId); });

  // PM Map
  var pmMap = null;
  function renderPmMap(deal) {
    var p = deal.property || {};
    var address = [p.address, p.city, p.state, p.zip].filter(Boolean).join(", ");
    var mapEl = document.getElementById("pm-map");
    if (pmMap) { pmMap.remove(); pmMap = null; }
    if (!address) {
      mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.85rem">No address</div>';
      return;
    }
    pmMap = L.map(mapEl).setView([39.8283, -98.5795], 4);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap', maxZoom: 19
    }).addTo(pmMap);
    fetch("https://nominatim.openstreetmap.org/search?format=json&q=" + encodeURIComponent(address) + "&limit=1", {
      headers: { "User-Agent": "UmbrellaPlace-PM/1.0" }
    })
    .then(function(r) { if (!r.ok) throw new Error("Geocoding failed"); return r.json(); })
    .then(function(results) {
      if (results && results.length > 0) {
        var lat = parseFloat(results[0].lat);
        var lon = parseFloat(results[0].lon);
        pmMap.setView([lat, lon], 17);
        L.marker([lat, lon]).addTo(pmMap)
          .bindPopup("<strong>" + escHtml(p.address || "") + "</strong><br>" + escHtml((p.city || "") + (p.state ? ", " + p.state : ""))).openPopup();
      } else {
        L.marker(pmMap.getCenter()).addTo(pmMap).bindPopup("Address not found on map").openPopup();
      }
    }).catch(function(err) {
      console.warn("PM map geocoding error:", err);
      L.marker(pmMap.getCenter()).addTo(pmMap).bindPopup("Could not locate address").openPopup();
    });
    setTimeout(function() { if (pmMap) pmMap.invalidateSize(); }, 300);
  }

  // PM House Info — editable fields
  function renderPmHouseInfo(deal) {
    var p = deal.property || {};
    ["beds","baths","sqft","yearBuilt","monthlyRent","stories"].forEach(function(k) {
      var el = document.getElementById("pm-prop-" + k.replace("yearBuilt","year").replace("monthlyRent","rent"));
      if (el) el.value = p[k] || "";
    });
    var typeEl = document.getElementById("pm-prop-type");
    if (typeEl) typeEl.value = p.type || "";
    var condEl = document.getElementById("pm-prop-condition");
    if (condEl) condEl.value = p.condition || "";
    var stratEl = document.getElementById("pm-prop-strategy");
    if (stratEl) stratEl.value = p.strategy || "";
  }

  // Debounced property detail saves
  var pmPropQueue = {};
  var pmPropTimer = null;
  document.querySelectorAll(".pm-prop-input").forEach(function(inp) {
    var evt = inp.tagName === "SELECT" ? "change" : "blur";
    inp.addEventListener(evt, function() {
      if (!pmCurrentId) return;
      var field = inp.dataset.field;
      var val = inp.type === "number" ? (parseFloat(inp.value) || 0) : inp.value;
      var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
      if (deal) { if (!deal.property) deal.property = {}; deal.property[field] = val; }
      pmPropQueue["property." + field] = val;
      clearTimeout(pmPropTimer);
      pmPropTimer = setTimeout(async function() {
        var updates = Object.assign({}, pmPropQueue, { updatedAt: new Date().toISOString() });
        pmPropQueue = {};
        try { await db.collection("deal-analyzer").doc(pmCurrentId).update(updates); showSaveIndicator(); }
        catch (err) { showToast("Failed to save", "error"); }
      }, 800);
    });
  });

  // ===== AUTO-POPULATE ROOM ITEMS =====
  var ROOM_DEFAULT_ITEMS = {
    kitchen: [
      { name: "Refrigerator", category: "appliance" },
      { name: "Stove / Range", category: "appliance" },
      { name: "Dishwasher", category: "appliance" },
      { name: "Microwave", category: "appliance" },
      { name: "Kitchen Sink", category: "fixture" },
      { name: "Kitchen Faucet", category: "fixture" },
      { name: "Garbage Disposal", category: "appliance" },
      { name: "Range Hood", category: "appliance" },
      { name: "Cabinets", category: "fixture" },
      { name: "Countertops", category: "material" },
      { name: "Backsplash", category: "material" },
      { name: "Flooring", category: "material" },
      { name: "Light Fixtures", category: "fixture" },
    ],
    bathroom: [
      { name: "Toilet", category: "fixture" },
      { name: "Vanity / Sink", category: "fixture" },
      { name: "Bathroom Faucet", category: "fixture" },
      { name: "Bathtub / Shower", category: "fixture" },
      { name: "Shower Head", category: "fixture" },
      { name: "Mirror / Medicine Cabinet", category: "fixture" },
      { name: "Exhaust Fan", category: "fixture" },
      { name: "Towel Bar / Hooks", category: "fixture" },
      { name: "Flooring", category: "material" },
      { name: "Light Fixture", category: "fixture" },
    ],
    bedroom: [
      { name: "Ceiling Fan / Light", category: "fixture" },
      { name: "Flooring", category: "material" },
      { name: "Window Blinds", category: "fixture" },
      { name: "Closet Shelving", category: "fixture" },
      { name: "Smoke Detector", category: "fixture" },
      { name: "Paint", category: "material" },
    ],
    living: [
      { name: "Ceiling Fan / Light", category: "fixture" },
      { name: "Flooring", category: "material" },
      { name: "Window Blinds", category: "fixture" },
      { name: "Paint", category: "material" },
      { name: "Thermostat", category: "appliance" },
      { name: "Smoke / CO Detector", category: "fixture" },
    ],
    dining: [
      { name: "Light Fixture / Chandelier", category: "fixture" },
      { name: "Flooring", category: "material" },
      { name: "Paint", category: "material" },
    ],
    laundry: [
      { name: "Washer", category: "appliance" },
      { name: "Dryer", category: "appliance" },
      { name: "Utility Sink", category: "fixture" },
      { name: "Shelving", category: "fixture" },
      { name: "Flooring", category: "material" },
    ],
    garage: [
      { name: "Garage Door", category: "fixture" },
      { name: "Garage Door Opener", category: "appliance" },
      { name: "Light Fixture", category: "fixture" },
      { name: "Flooring / Epoxy", category: "material" },
    ],
    foyer: [
      { name: "Entry Door / Lock", category: "fixture" },
      { name: "Light Fixture", category: "fixture" },
      { name: "Flooring", category: "material" },
      { name: "Doorbell / Smart Lock", category: "appliance" },
    ],
    office: [
      { name: "Ceiling Fan / Light", category: "fixture" },
      { name: "Flooring", category: "material" },
      { name: "Window Blinds", category: "fixture" },
      { name: "Paint", category: "material" },
    ],
    porch: [
      { name: "Exterior Light", category: "fixture" },
      { name: "Decking / Flooring", category: "material" },
      { name: "Railing", category: "material" },
    ],
    pantry: [
      { name: "Shelving", category: "fixture" },
      { name: "Light Fixture", category: "fixture" },
    ],
    hallway: [
      { name: "Light Fixture", category: "fixture" },
      { name: "Flooring", category: "material" },
      { name: "Smoke Detector", category: "fixture" },
      { name: "Paint", category: "material" },
    ],
  };
  // Also add whole-house items
  var WHOLE_HOUSE_ITEMS = [
    { name: "HVAC System", category: "appliance", room: "" },
    { name: "Water Heater", category: "appliance", room: "" },
    { name: "Electrical Panel", category: "fixture", room: "" },
    { name: "Roof", category: "material", room: "" },
    { name: "Exterior Siding", category: "material", room: "" },
    { name: "Exterior Paint", category: "material", room: "" },
    { name: "Foundation", category: "material", room: "" },
    { name: "Plumbing Main", category: "fixture", room: "" },
    { name: "Landscaping", category: "material", room: "" },
    { name: "Driveway", category: "material", room: "" },
    { name: "Fence", category: "material", room: "" },
    { name: "Gutters", category: "material", room: "" },
    { name: "Windows (whole house)", category: "material", room: "" },
  ];

  function autoPopulateItems(deal) {
    var fp = deal.floorPlan;
    if (!fp || !fp.rooms || !fp.rooms.length) { showToast("Generate a floor plan first", "error"); return; }
    if (!deal.propertyMgmt) deal.propertyMgmt = {};
    if (!deal.propertyMgmt.items) deal.propertyMgmt.items = [];

    var existing = deal.propertyMgmt.items;
    var existingKeys = {};
    existing.forEach(function(i) { existingKeys[(i.room || "") + "||" + i.name] = true; });

    var newItems = [];
    // Room-specific items
    fp.rooms.forEach(function(room) {
      var defaults = ROOM_DEFAULT_ITEMS[room.type] || ROOM_DEFAULT_ITEMS.living || [];
      defaults.forEach(function(d) {
        var key = room.name + "||" + d.name;
        if (!existingKeys[key]) {
          newItems.push({ id: uid(), name: d.name, room: room.name, category: d.category, cost: 0, date: "", brand: "", notes: "" });
          existingKeys[key] = true;
        }
      });
    });
    // Whole house items
    WHOLE_HOUSE_ITEMS.forEach(function(d) {
      var key = "||" + d.name;
      if (!existingKeys[key]) {
        newItems.push({ id: uid(), name: d.name, room: "", category: d.category, cost: 0, date: "", brand: "", notes: "" });
        existingKeys[key] = true;
      }
    });

    return newItems;
  }

  // PM Lot info save
  function renderPmLotInfo(deal) {
    var lot = (deal.propertyMgmt || {}).lot || {};
    ["lotAcres","lotWidth","lotDepth","zoning","parking","lotFeatures"].forEach(function(k) {
      var el = document.querySelector('.pm-lot-input[data-field="' + k + '"]');
      if (el) el.value = lot[k] || "";
    });
  }
  // Debounced PM lot field saves
  var pmLotQueue = {};
  var pmLotTimer = null;
  document.querySelectorAll(".pm-lot-input").forEach(function(inp) {
    inp.addEventListener("blur", function() {
      if (!pmCurrentId) return;
      var field = inp.dataset.field;
      var val = inp.type === "number" ? (parseFloat(inp.value) || 0) : inp.value.trim();
      var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
      if (deal) {
        if (!deal.propertyMgmt) deal.propertyMgmt = {};
        if (!deal.propertyMgmt.lot) deal.propertyMgmt.lot = {};
        deal.propertyMgmt.lot[field] = val;
      }
      drawPmFloorPlan();
      pmLotQueue["propertyMgmt.lot." + field] = val;
      clearTimeout(pmLotTimer);
      pmLotTimer = setTimeout(async function() {
        var updates = Object.assign({}, pmLotQueue, { updatedAt: new Date().toISOString() });
        pmLotQueue = {};
        try { await db.collection("deal-analyzer").doc(pmCurrentId).update(updates); showSaveIndicator(); }
        catch (err) { showToast("Failed to save", "error"); }
      }, 800);
    });
  });

  // PM Floor Plan — full interactive editor
  var pmFp = null; // working copy
  var pmFpEdit = false;
  var pmFpSel = null;
  var pmFpDirty = false;
  var pmFpScale = 1;
  var pmFpDrag = null;

  function renderPmFloorPlan(deal) {
    var svg = document.getElementById("pm-fp-svg");
    var empty = document.getElementById("pm-fp-empty");
    var fp = deal.floorPlan;
    pmFpZoom = 1; pmFpFloor = 1; pmFpEdit = false; pmFpSel = null; pmFpDirty = false;
    setPmEditUI(false);

    if (!fp || !fp.rooms || !fp.rooms.length) {
      svg.style.display = "none"; empty.style.display = ""; pmFp = null;
      // Pre-fill the generate form from property data
      var p = deal.property || {};
      var gBeds = document.getElementById("pm-gen-beds");
      var gBaths = document.getElementById("pm-gen-baths");
      var gSqft = document.getElementById("pm-gen-sqft");
      var gStories = document.getElementById("pm-gen-stories");
      var gYear = document.getElementById("pm-gen-year");
      if (gBeds) gBeds.value = p.beds || "";
      if (gBaths) gBaths.value = p.baths || "";
      if (gSqft) gSqft.value = p.sqft || "";
      if (gStories) gStories.value = p.stories || "1";
      if (gYear) gYear.value = p.yearBuilt || "";
      // Wire up generate button (fresh each time to avoid stale closures)
      var btn = document.getElementById("pm-btn-generate-fp");
      if (btn) {
        var newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener("click", function() { generatePmFloorPlan(); });
      }
      return;
    }
    pmFp = JSON.parse(JSON.stringify(fp));
    empty.style.display = "none"; svg.style.display = "";
    document.getElementById("pm-fp-floor").style.display = fp.stories > 1 ? "" : "none";
    drawPmFloorPlan();
  }

  async function generatePmFloorPlan() {
    if (!pmCurrentId) return;
    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (!deal) return;
    var p = deal.property || {};
    if (!p.address) { showToast("Add an address in Property Details first", "error"); return; }

    // Read values from the generate form (user may have adjusted)
    var beds = parseInt(document.getElementById("pm-gen-beds").value) || p.beds || 3;
    var baths = parseFloat(document.getElementById("pm-gen-baths").value) || p.baths || 2;
    var sqft = parseInt(document.getElementById("pm-gen-sqft").value) || p.sqft || 1500;
    var stories = parseInt(document.getElementById("pm-gen-stories").value) || 1;
    var style = document.getElementById("pm-gen-style").value || "open";
    var garage = document.getElementById("pm-gen-garage").value || "yes";
    var yearBuilt = parseInt(document.getElementById("pm-gen-year").value) || p.yearBuilt || 0;

    // Also save updated values back to property
    deal.property.beds = beds;
    deal.property.baths = baths;
    deal.property.sqft = sqft;
    deal.property.stories = stories;
    deal.property.yearBuilt = yearBuilt;

    var genProperty = Object.assign({}, p, { beds: beds, baths: baths, sqft: sqft, stories: stories, yearBuilt: yearBuilt, style: style, hasGarage: garage === "yes" });

    var btn = document.getElementById("pm-btn-generate-fp");
    if (btn) { btn.disabled = true; btn.textContent = "Generating... (~15s)"; }
    try {
      var token = await currentUser.getIdToken();
      var res = await fetch(FUNCTIONS_BASE + "/generateFloorPlan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ property: genProperty })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      deal.floorPlan = data.floorPlan;
      await db.collection("deal-analyzer").doc(pmCurrentId).update({
        floorPlan: data.floorPlan,
        "property.beds": beds, "property.baths": baths, "property.sqft": sqft,
        "property.stories": stories, "property.yearBuilt": yearBuilt,
        updatedAt: new Date().toISOString()
      });
      renderPmFloorPlan(deal);
      populatePmRoomDropdowns(deal);
      renderPmHouseInfo(deal);
      showToast("Floor plan generated — click Edit to customize", "success");
    } catch (err) {
      console.error("PM floor plan error:", err);
      showToast("Failed to generate: " + err.message, "error");
      if (btn) { btn.disabled = false; btn.textContent = "Generate Floor Plan with AI"; }
    }
  }

  function setPmEditUI(isOn) {
    pmFpEdit = isOn;
    var ids = { "pm-fp-edit-bar": isOn ? "flex" : "none", "pm-fp-add-room": isOn ? "" : "none", "pm-fp-del-room": isOn ? "" : "none", "pm-fp-save": isOn ? "" : "none" };
    Object.keys(ids).forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = ids[id]; });
    var editBtn = document.getElementById("pm-fp-edit");
    if (editBtn) { editBtn.textContent = isOn ? "View" : "Edit"; editBtn.style.color = isOn ? "#2563eb" : ""; }
    if (!isOn) { var ap = document.getElementById("pm-fp-add-panel"); if (ap) ap.style.display = "none"; }
  }

  function updatePmDirty() {
    var el = document.getElementById("pm-fp-dirty");
    el.textContent = pmFpDirty ? "Unsaved changes" : "All saved";
    el.style.color = pmFpDirty ? "#dc2626" : "#059669";
  }

  function drawPmFloorPlan() {
    if (!pmFp) return;
    var svg = document.getElementById("pm-fp-svg");
    var container = document.getElementById("pm-floorplan-container");
    var rooms = pmFp.rooms.filter(function(r) { return (r.floor || 1) === pmFpFloor; });
    var dims = pmFp.dimensions || {};
    var planW = dims.width || 60;
    var planH = dims.height || 40;
    rooms.forEach(function(r) {
      if (r.x + r.width > planW) planW = r.x + r.width + 2;
      if (r.y + r.height > planH) planH = r.y + r.height + 2;
    });

    // Get lot info for outline
    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    var lot = ((deal || {}).propertyMgmt || {}).lot || {};
    var lotW = lot.lotWidth || 0;
    var lotD = lot.lotDepth || 0;
    // If lot is bigger than plan, use lot as outer bounds for scale
    var outerW = Math.max(planW, lotW) + 4;
    var outerH = Math.max(planH, lotD) + 4;

    var cW = container.clientWidth - 20;
    var cH = container.clientHeight - 10 || 400;
    pmFpScale = Math.min(cW / outerW, cH / outerH) * 0.8;
    var pad = 30;
    var svgW = Math.round(outerW * pmFpScale + pad * 2);
    var svgH = Math.round(outerH * pmFpScale + pad * 2);
    svg.setAttribute("width", svgW * pmFpZoom);
    svg.setAttribute("height", svgH * pmFpZoom);
    svg.setAttribute("viewBox", "0 0 " + svgW + " " + svgH);

    // Item counts per room
    var pmItems = ((deal || {}).propertyMgmt || {}).items || [];
    var roomItemCount = {};
    pmItems.forEach(function(item) { if (item.room) roomItemCount[item.room] = (roomItemCount[item.room] || 0) + 1; });

    var html = "";

    // Lot outline (green dashed)
    if (lotW > 0 && lotD > 0) {
      var lotPx = lotW * pmFpScale;
      var lotPy = lotD * pmFpScale;
      var lotOx = pad + (outerW * pmFpScale - lotPx) / 2;
      var lotOy = pad + (outerH * pmFpScale - lotPy) / 2;
      html += '<rect x="' + lotOx + '" y="' + lotOy + '" width="' + lotPx + '" height="' + lotPy + '" fill="#f0fdf4" stroke="#16a34a" stroke-width="2" stroke-dasharray="8 4" rx="4"/>';
      // Lot dimensions
      html += '<text x="' + (lotOx + lotPx / 2) + '" y="' + (lotOy - 6) + '" text-anchor="middle" font-size="9" fill="#16a34a" font-weight="600">' + lotW + ' ft</text>';
      html += '<text x="' + (lotOx - 6) + '" y="' + (lotOy + lotPy / 2) + '" text-anchor="middle" font-size="9" fill="#16a34a" font-weight="600" transform="rotate(-90,' + (lotOx - 6) + ',' + (lotOy + lotPy / 2) + ')">' + lotD + ' ft</text>';
      var acres = lot.lotAcres || (lotW * lotD / 43560);
      html += '<text x="' + (lotOx + lotPx - 4) + '" y="' + (lotOy + lotPy - 4) + '" text-anchor="end" font-size="8" fill="#16a34a">' + acres.toFixed(2) + ' ac</text>';
    }

    // Grid in edit mode
    if (pmFpEdit) {
      var gOx = pad + (outerW * pmFpScale - planW * pmFpScale) / 2;
      var gOy = pad + (outerH * pmFpScale - planH * pmFpScale) / 2;
      html += '<defs><pattern id="pm-grid" width="' + pmFpScale + '" height="' + pmFpScale + '" patternUnits="userSpaceOnUse">';
      html += '<path d="M ' + pmFpScale + ' 0 L 0 0 0 ' + pmFpScale + '" fill="none" stroke="#e5e7eb" stroke-width="0.5"/>';
      html += '</pattern></defs>';
      html += '<rect x="' + gOx + '" y="' + gOy + '" width="' + (planW * pmFpScale) + '" height="' + (planH * pmFpScale) + '" fill="url(#pm-grid)" stroke="#d1d5db" stroke-width="1"/>';
    }

    // House outline
    var hOx = pad + (outerW * pmFpScale - planW * pmFpScale) / 2;
    var hOy = pad + (outerH * pmFpScale - planH * pmFpScale) / 2;
    html += '<rect x="' + (hOx - 2) + '" y="' + (hOy - 2) + '" width="' + (planW * pmFpScale + 4) + '" height="' + (planH * pmFpScale + 4) + '" fill="none" stroke="#374151" stroke-width="2" rx="3"/>';

    // Rooms (selected on top)
    var sorted = rooms.slice().sort(function(a, b) {
      if (a.id === pmFpSel) return 1; if (b.id === pmFpSel) return -1; return 0;
    });

    sorted.forEach(function(room) {
      var rx = hOx + room.x * pmFpScale;
      var ry = hOy + room.y * pmFpScale;
      var rw = room.width * pmFpScale;
      var rh = room.height * pmFpScale;
      var color = ROOM_COLORS[room.type] || "#f3f4f6";
      var border = ROOM_BORDERS[room.type] || "#9ca3af";
      var isSel = pmFpEdit && room.id === pmFpSel;
      var fontSize = Math.max(8, Math.min(12, rw / 8));
      var subFont = Math.max(7, fontSize - 2);
      var iCount = roomItemCount[room.name] || 0;

      html += '<g class="pm-fp-room" data-room-id="' + room.id + '" data-room-name="' + escHtml(room.name) + '" style="cursor:' + (pmFpEdit ? "move" : "pointer") + '">';
      html += '<rect class="pm-fp-rect" x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '" fill="' + (isSel ? "#dbeafe" : color) + '" stroke="' + (isSel ? "#2563eb" : border) + '" stroke-width="' + (isSel ? 3 : 2) + '" rx="2"/>';
      var cx = rx + rw / 2, cy = ry + rh / 2;
      html += '<text x="' + cx + '" y="' + (cy - subFont * 0.3) + '" text-anchor="middle" font-size="' + fontSize + '" font-weight="600" fill="#374151" pointer-events="none">' + escHtml(room.name) + '</text>';
      html += '<text x="' + cx + '" y="' + (cy + fontSize * 0.7) + '" text-anchor="middle" font-size="' + subFont + '" fill="#6b7280" pointer-events="none">' + room.width + "\u2032 x " + room.height + "\u2032</text>";
      // Item badge
      if (iCount > 0) {
        html += '<circle cx="' + (rx + rw - 8) + '" cy="' + (ry + 8) + '" r="9" fill="#2563eb"/>';
        html += '<text x="' + (rx + rw - 8) + '" y="' + (ry + 12) + '" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" pointer-events="none">' + iCount + '</text>';
      }
      // Resize handles
      if (isSel) {
        var hs = 8;
        html += '<rect class="pm-fp-handle" data-handle="resize-e" x="' + (rx + rw - hs / 2) + '" y="' + (ry + rh / 2 - hs) + '" width="' + hs + '" height="' + (hs * 2) + '" fill="#2563eb" rx="2" style="cursor:e-resize"/>';
        html += '<rect class="pm-fp-handle" data-handle="resize-s" x="' + (rx + rw / 2 - hs) + '" y="' + (ry + rh - hs / 2) + '" width="' + (hs * 2) + '" height="' + hs + '" fill="#2563eb" rx="2" style="cursor:s-resize"/>';
        html += '<rect class="pm-fp-handle" data-handle="resize-se" x="' + (rx + rw - hs) + '" y="' + (ry + rh - hs) + '" width="' + hs + '" height="' + hs + '" fill="#1d4ed8" rx="2" style="cursor:se-resize"/>';
        html += '<rect class="pm-fp-handle" data-handle="resize-w" x="' + (rx - hs / 2) + '" y="' + (ry + rh / 2 - hs) + '" width="' + hs + '" height="' + (hs * 2) + '" fill="#2563eb" rx="2" style="cursor:w-resize"/>';
        html += '<rect class="pm-fp-handle" data-handle="resize-n" x="' + (rx + rw / 2 - hs) + '" y="' + (ry - hs / 2) + '" width="' + (hs * 2) + '" height="' + hs + '" fill="#2563eb" rx="2" style="cursor:n-resize"/>';
      }
      html += '</g>';
    });

    // Scale bar + total sf
    var sbPx = 10 * pmFpScale;
    html += '<line x1="' + pad + '" y1="' + (svgH - 8) + '" x2="' + (pad + sbPx) + '" y2="' + (svgH - 8) + '" stroke="#6b7280" stroke-width="2"/>';
    html += '<text x="' + (pad + sbPx / 2) + '" y="' + (svgH - 12) + '" text-anchor="middle" font-size="9" fill="#6b7280">10 ft</text>';
    var totalSf = rooms.reduce(function(s, r) { return s + Math.round(r.width * r.height); }, 0);
    html += '<text x="' + (svgW - 8) + '" y="' + (svgH - 8) + '" text-anchor="end" font-size="9" fill="#6b7280">' + totalSf + ' sf</text>';
    html += '<text x="' + (svgW - 16) + '" y="22" text-anchor="end" font-size="11" font-weight="700" fill="#6b7280">N ▲</text>';

    svg.innerHTML = html;
    attachPmFpEvents(rooms, roomItemCount);
  }

  function attachPmFpEvents(rooms, roomItemCount) {
    var svg = document.getElementById("pm-fp-svg");
    var tooltip = document.getElementById("pm-fp-tooltip");
    var container = document.getElementById("pm-floorplan-container");

    svg.querySelectorAll(".pm-fp-room").forEach(function(g) {
      var rid = g.dataset.roomId;
      var roomName = g.dataset.roomName;

      // Hover
      g.addEventListener("mouseenter", function() {
        if (pmFpDrag) return;
        var cnt = roomItemCount[roomName] || 0;
        tooltip.innerHTML = "<strong>" + escHtml(roomName) + "</strong><br>" + cnt + " item" + (cnt !== 1 ? "s" : "") + (pmFpEdit ? "" : "<br><em>Click to add item</em>");
        tooltip.style.display = "block";
        if (!pmFpEdit) { var r = g.querySelector(".pm-fp-rect"); if (r) r.setAttribute("fill", "#dbeafe"); }
      });
      g.addEventListener("mousemove", function(e) {
        if (pmFpDrag) return;
        var cr = container.getBoundingClientRect();
        tooltip.style.left = (e.clientX - cr.left + 12) + "px";
        tooltip.style.top = (e.clientY - cr.top - 10) + "px";
      });
      g.addEventListener("mouseleave", function() {
        tooltip.style.display = "none";
        if (!pmFpEdit) {
          var room = rooms.find(function(r) { return r.name === roomName; });
          var rect = g.querySelector(".pm-fp-rect");
          if (rect && room) rect.setAttribute("fill", ROOM_COLORS[room.type] || "#f3f4f6");
        }
      });

      // Double-click to rename — works in BOTH modes
      var pmDblClickTimer = null;
      g.addEventListener("dblclick", function(e) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(pmDblClickTimer);
        pmDblClickTimer = null;
        var room = pmFp.rooms.find(function(r) { return r.id === rid; });
        if (!room) return;
        var nn = prompt("Room name:", room.name);
        if (nn !== null && nn.trim()) {
          room.name = nn.trim();
          pmFpDirty = true; updatePmDirty();
          var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
          if (deal) populatePmRoomDropdowns(deal);
          drawPmFloorPlan();
        }
      });

      if (pmFpEdit) {
        // Edit mode: first click selects (delayed for dblclick), drag when already selected
        g.addEventListener("mousedown", function(e) {
          if (e.target.classList.contains("pm-fp-handle")) return;
          e.preventDefault();
          tooltip.style.display = "none";
          var room = pmFp.rooms.find(function(r) { return r.id === rid; });
          if (!room) return;

          if (pmFpSel !== rid) {
            // Delay redraw so dblclick can fire first
            pmFpSel = rid;
            pmDblClickTimer = setTimeout(function() { pmDblClickTimer = null; drawPmFloorPlan(); }, 300);
          } else {
            // Already selected — start drag
            pmFpDrag = { type: "move", roomId: rid, startX: e.clientX, startY: e.clientY, origX: room.x, origY: room.y, origW: room.width, origH: room.height, el: g };
          }
        });
      } else {
        // View mode: single click to add item (delayed for dblclick)
        g.addEventListener("click", function() {
          pmDblClickTimer = setTimeout(function() {
            pmDblClickTimer = null;
            document.getElementById("pm-item-room-filter").value = roomName;
            renderPmItems();
            document.getElementById("pm-add-item-form").style.display = "";
            document.getElementById("pm-item-room").value = roomName;
            document.getElementById("pm-item-name").focus();
          }, 300);
        });
      }
    });

    // Resize handles
    if (pmFpEdit) {
      svg.querySelectorAll(".pm-fp-handle").forEach(function(h) {
        h.addEventListener("mousedown", function(e) {
          e.preventDefault(); e.stopPropagation();
          var room = pmFp.rooms.find(function(r) { return r.id === pmFpSel; });
          if (!room) return;
          pmFpDrag = { type: h.dataset.handle, roomId: pmFpSel, startX: e.clientX, startY: e.clientY, origX: room.x, origY: room.y, origW: room.width, origH: room.height };
        });
      });
      svg.addEventListener("mousedown", function(e) {
        if (e.target === svg || (e.target.tagName === "rect" && !e.target.closest(".pm-fp-room") && !e.target.classList.contains("pm-fp-handle"))) {
          pmFpSel = null; drawPmFloorPlan();
        }
      });
    }
  }

  // PM drag handlers — use translate transforms during drag, full redraw on mouseup
  document.addEventListener("mousemove", function(e) {
    if (!pmFpDrag || !pmFp) return;
    var room = pmFp.rooms.find(function(r) { return r.id === pmFpDrag.roomId; });
    if (!room) return;
    var dxPx = e.clientX - pmFpDrag.startX;
    var dyPx = e.clientY - pmFpDrag.startY;
    var dx = dxPx / (pmFpScale * pmFpZoom);
    var dy = dyPx / (pmFpScale * pmFpZoom);

    if (pmFpDrag.type === "move") {
      room.x = Math.round(Math.max(0, pmFpDrag.origX + dx));
      room.y = Math.round(Math.max(0, pmFpDrag.origY + dy));
      // Live translate the SVG group (no redraw)
      if (pmFpDrag.el) {
        var tdx = (room.x - pmFpDrag.origX) * pmFpScale;
        var tdy = (room.y - pmFpDrag.origY) * pmFpScale;
        pmFpDrag.el.setAttribute("transform", "translate(" + tdx + "," + tdy + ")");
      }
    } else {
      // For resize, update model and do a full redraw (less frequent)
      if (pmFpDrag.type === "resize-e") { room.width = Math.round(Math.max(3, pmFpDrag.origW + dx)); }
      else if (pmFpDrag.type === "resize-s") { room.height = Math.round(Math.max(3, pmFpDrag.origH + dy)); }
      else if (pmFpDrag.type === "resize-se") { room.width = Math.round(Math.max(3, pmFpDrag.origW + dx)); room.height = Math.round(Math.max(3, pmFpDrag.origH + dy)); }
      else if (pmFpDrag.type === "resize-w") { var nx = Math.round(pmFpDrag.origX + dx); var nw = pmFpDrag.origW + (pmFpDrag.origX - nx); if (nw >= 3) { room.x = nx; room.width = nw; } }
      else if (pmFpDrag.type === "resize-n") { var ny = Math.round(pmFpDrag.origY + dy); var nh = pmFpDrag.origH + (pmFpDrag.origY - ny); if (nh >= 3) { room.y = ny; room.height = nh; } }
      // Throttled redraw for resize
      if (!pmFpDrag._resizeRaf) {
        pmFpDrag._resizeRaf = requestAnimationFrame(function() {
          pmFpDrag._resizeRaf = null;
          drawPmFloorPlan();
        });
      }
    }
    pmFpDirty = true;
  });
  document.addEventListener("mouseup", function() {
    if (pmFpDrag) {
      pmFpDrag = null;
      updatePmDirty();
      drawPmFloorPlan(); // full redraw to snap to final position with handles
    }
  });

  // PM edit controls
  on("pm-fp-edit", "click", function() {
    if (!pmFp) return; pmFpEdit = !pmFpEdit; pmFpSel = null; setPmEditUI(pmFpEdit); drawPmFloorPlan();
  });
  on("pm-fp-zoom-in", "click", function() { pmFpZoom = Math.min(pmFpZoom + 0.25, 3); if (pmFp) drawPmFloorPlan(); });
  on("pm-fp-zoom-out", "click", function() { pmFpZoom = Math.max(pmFpZoom - 0.25, 0.5); if (pmFp) drawPmFloorPlan(); });
  on("pm-fp-floor", "change", function(e) { pmFpFloor = parseInt(e.target.value); pmFpSel = null; if (pmFp) drawPmFloorPlan(); });

  // Add room
  on("pm-fp-add-room", "click", function() {
    var p = document.getElementById("pm-fp-add-panel");
    p.style.display = p.style.display === "none" ? "" : "none";
  });
  on("pm-fp-add-cancel", "click", function() { document.getElementById("pm-fp-add-panel").style.display = "none"; });
  on("pm-fp-add-confirm", "click", function() {
    if (!pmFp) return;
    var name = document.getElementById("pm-fp-new-name").value.trim() || "New Room";
    var type = document.getElementById("pm-fp-new-type").value;
    var w = parseInt(document.getElementById("pm-fp-new-w").value) || 12;
    var h = parseInt(document.getElementById("pm-fp-new-h").value) || 12;
    var rooms = pmFp.rooms.filter(function(r) { return (r.floor || 1) === pmFpFloor; });
    var maxX = 0, maxY = 0;
    rooms.forEach(function(r) { if (r.x + r.width > maxX) { maxX = r.x + r.width; maxY = r.y; } });
    var nr = { id: "room-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), name: name, type: type, floor: pmFpFloor, x: maxX + 1, y: maxY, width: w, height: h, features: [] };
    pmFp.rooms.push(nr);
    pmFpSel = nr.id; pmFpDirty = true; updatePmDirty();
    document.getElementById("pm-fp-add-panel").style.display = "none";
    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (deal) populatePmRoomDropdowns(deal);
    drawPmFloorPlan();
    showToast("Room added — drag to position", "success");
  });

  // Delete room
  on("pm-fp-del-room", "click", function() {
    if (!pmFp || !pmFpSel) { showToast("Select a room first", "error"); return; }
    var room = pmFp.rooms.find(function(r) { return r.id === pmFpSel; });
    if (!room || !confirm('Delete "' + room.name + '"?')) return;
    pmFp.rooms = pmFp.rooms.filter(function(r) { return r.id !== pmFpSel; });
    pmFpSel = null; pmFpDirty = true; updatePmDirty();
    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (deal) populatePmRoomDropdowns(deal);
    drawPmFloorPlan();
  });

  // Save PM floor plan
  on("pm-fp-save", "click", async function() {
    if (!pmCurrentId || !pmFp) return;
    var btn = document.getElementById("pm-fp-save");
    btn.disabled = true; btn.textContent = "Saving...";
    try {
      await db.collection("deal-analyzer").doc(pmCurrentId).update({ floorPlan: pmFp, updatedAt: new Date().toISOString() });
      var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
      if (deal) deal.floorPlan = JSON.parse(JSON.stringify(pmFp));
      pmFpDirty = false; updatePmDirty();
      populatePmRoomDropdowns(deal);
      showToast("Floor plan saved", "success");
    } catch (err) { showToast("Failed to save", "error"); }
    finally { btn.disabled = false; btn.textContent = "Save"; }
  });

  // Generate floor plan handler is wired up dynamically inside renderPmFloorPlan()

  // Populate room dropdowns from floor plan
  function populatePmRoomDropdowns(deal) {
    var fp = deal.floorPlan;
    var roomNames = fp ? fp.rooms.map(function(r) { return r.name; }) : [];
    var filterSelect = document.getElementById("pm-item-room-filter");
    var formSelect = document.getElementById("pm-item-room");

    // Keep "All Rooms" / "-- Select --" as first option
    filterSelect.innerHTML = '<option value="">All Rooms</option>' + roomNames.map(function(n) { return '<option value="' + escHtml(n) + '">' + escHtml(n) + '</option>'; }).join("");
    formSelect.innerHTML = '<option value="">-- General --</option>' + roomNames.map(function(n) { return '<option value="' + escHtml(n) + '">' + escHtml(n) + '</option>'; }).join("");
  }

  // Items
  function renderPmItems(deal) {
    if (!deal) deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (!deal) return;
    var pm = deal.propertyMgmt || {};
    var items = (pm.items || []).slice();
    var roomFilter = document.getElementById("pm-item-room-filter").value;
    var catFilter = document.getElementById("pm-item-cat-filter").value;
    if (roomFilter) items = items.filter(function(i) { return i.room === roomFilter; });
    if (catFilter) items = items.filter(function(i) { return i.category === catFilter; });
    items.sort(function(a, b) { return (b.date || "").localeCompare(a.date || ""); });

    var tbody = document.getElementById("pm-items-tbody");
    var empty = document.getElementById("pm-items-empty");
    if (!items.length) { tbody.innerHTML = ""; empty.style.display = "block"; } else { empty.style.display = "none"; }

    tbody.innerHTML = items.map(function(item) {
      return '<tr>' +
        '<td><strong>' + escHtml(item.name || "") + '</strong>' + (item.notes ? '<br><span style="font-size:0.7rem;color:var(--text-muted)">' + escHtml(item.notes) + '</span>' : '') + '</td>' +
        '<td>' + escHtml(item.room || "General") + '</td>' +
        '<td><span class="badge" style="font-size:0.7rem">' + (PM_CAT_LABELS[item.category] || item.category || "") + '</span></td>' +
        '<td>' + fmtDealDollar(item.cost) + '</td>' +
        '<td>' + (item.date || "—") + '</td>' +
        '<td style="font-size:0.75rem">' + escHtml(item.brand || "") + '</td>' +
        '<td><button class="btn btn-secondary btn-sm pm-del-item" data-item-id="' + item.id + '" style="padding:0.1rem 0.35rem;font-size:0.65rem;color:#dc2626">&times;</button></td>' +
        '</tr>';
    }).join("");

    var allItems = (pm.items || []);
    var dispItems = items;
    document.getElementById("pm-items-count").textContent = dispItems.length + " item" + (dispItems.length !== 1 ? "s" : "") + (roomFilter || catFilter ? " (filtered)" : "");
    document.getElementById("pm-items-total").textContent = fmtDealDollar(dispItems.reduce(function(s, i) { return s + (i.cost || 0); }, 0)) + " total";

    tbody.querySelectorAll(".pm-del-item").forEach(function(btn) {
      btn.addEventListener("click", function() { removePmItem(btn.dataset.itemId); });
    });
  }

  on("pm-btn-add-item", "click", function() {
    var f = document.getElementById("pm-add-item-form");
    f.style.display = f.style.display === "none" ? "" : "none";
  });

  // Auto-populate with preview modal
  var pendingAutoItems = [];
  on("pm-btn-auto-populate", "click", function() {
    if (!pmCurrentId) return;
    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (!deal) return;
    var newItems = autoPopulateItems(deal);
    if (!newItems || !newItems.length) { showToast("All expected items already exist", "success"); return; }

    pendingAutoItems = newItems;
    // Render preview grouped by room
    var byRoom = {};
    newItems.forEach(function(item) {
      var room = item.room || "Whole House";
      if (!byRoom[room]) byRoom[room] = [];
      byRoom[room].push(item);
    });
    var html = "";
    Object.keys(byRoom).forEach(function(room) {
      html += '<div style="margin-bottom:0.75rem"><strong style="font-size:0.85rem;color:#374151">' + escHtml(room) + '</strong> <span style="color:#94a3b8">(' + byRoom[room].length + ')</span>';
      byRoom[room].forEach(function(item) {
        html += '<div style="display:flex;align-items:center;gap:0.4rem;padding:0.2rem 0 0.2rem 0.75rem">';
        html += '<input type="checkbox" class="pm-auto-item-check" data-item-id="' + item.id + '" checked />';
        html += '<span>' + escHtml(item.name) + '</span>';
        html += '<span style="color:#94a3b8;font-size:0.7rem;margin-left:auto">' + (PM_CAT_LABELS[item.category] || item.category) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    });
    document.getElementById("pm-auto-preview-list").innerHTML = html;
    document.getElementById("pm-auto-select-all").checked = true;
    updateAutoPreviewCount();
    document.getElementById("pm-auto-preview-overlay").style.display = "flex";

    // Wire up checkboxes
    document.querySelectorAll(".pm-auto-item-check").forEach(function(cb) {
      cb.addEventListener("change", updateAutoPreviewCount);
    });
  });

  function updateAutoPreviewCount() {
    var checked = document.querySelectorAll(".pm-auto-item-check:checked").length;
    var total = document.querySelectorAll(".pm-auto-item-check").length;
    document.getElementById("pm-auto-preview-count").textContent = checked + " of " + total + " items selected";
    document.getElementById("pm-auto-preview-confirm").disabled = checked === 0;
  }

  on("pm-auto-select-all", "change", function() {
    var checked = this.checked;
    document.querySelectorAll(".pm-auto-item-check").forEach(function(cb) { cb.checked = checked; });
    updateAutoPreviewCount();
  });

  on("pm-auto-preview-close", "click", function() {
    document.getElementById("pm-auto-preview-overlay").style.display = "none";
  });
  on("pm-auto-preview-cancel", "click", function() {
    document.getElementById("pm-auto-preview-overlay").style.display = "none";
  });

  on("pm-auto-preview-confirm", "click", async function() {
    var selected = {};
    document.querySelectorAll(".pm-auto-item-check:checked").forEach(function(cb) { selected[cb.dataset.itemId] = true; });
    var items = pendingAutoItems.filter(function(i) { return selected[i.id]; });
    if (!items.length) return;

    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (!deal) return;
    if (!deal.propertyMgmt) deal.propertyMgmt = {};
    if (!deal.propertyMgmt.items) deal.propertyMgmt.items = [];
    deal.propertyMgmt.items = deal.propertyMgmt.items.concat(items);
    try {
      await db.collection("deal-analyzer").doc(pmCurrentId).update({
        "propertyMgmt.items": deal.propertyMgmt.items,
        updatedAt: new Date().toISOString()
      });
      document.getElementById("pm-auto-preview-overlay").style.display = "none";
      renderPmItems(deal);
      if (deal.floorPlan) drawPmFloorPlan();
      showToast(items.length + " items added — fill in costs and brands as you go", "success");
    } catch (err) { showToast("Failed to save", "error"); }
  });

  on("pm-btn-save-item", "click", async function() {
    var name = document.getElementById("pm-item-name").value.trim();
    var room = document.getElementById("pm-item-room").value;
    var category = document.getElementById("pm-item-category").value;
    var cost = parseInt(document.getElementById("pm-item-cost").value) || 0;
    var date = document.getElementById("pm-item-date").value || new Date().toISOString().slice(0, 10);
    var brand = document.getElementById("pm-item-brand").value.trim();
    var notes = document.getElementById("pm-item-notes").value.trim();
    if (!name) { showToast("Item name required", "error"); return; }

    var item = { id: uid(), name: name, room: room, category: category, cost: cost, date: date, brand: brand, notes: notes };
    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (deal) {
      if (!deal.propertyMgmt) deal.propertyMgmt = {};
      if (!deal.propertyMgmt.items) deal.propertyMgmt.items = [];
      deal.propertyMgmt.items.push(item);
    }
    try {
      await db.collection("deal-analyzer").doc(pmCurrentId).update({
        "propertyMgmt.items": firebase.firestore.FieldValue.arrayUnion(item),
        updatedAt: new Date().toISOString()
      });
      ["pm-item-name","pm-item-brand","pm-item-notes","pm-item-cost"].forEach(function(id) { document.getElementById(id).value = ""; });
      document.getElementById("pm-add-item-form").style.display = "none";
      renderPmItems(deal);
      if (deal.floorPlan) drawPmFloorPlan(deal.floorPlan);
      showToast("Item added", "success");
    } catch (err) { showToast("Failed to save item", "error"); }
  });

  async function removePmItem(itemId) {
    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (!deal || !deal.propertyMgmt) return;
    deal.propertyMgmt.items = (deal.propertyMgmt.items || []).filter(function(i) { return i.id !== itemId; });
    try {
      await db.collection("deal-analyzer").doc(pmCurrentId).update({
        "propertyMgmt.items": deal.propertyMgmt.items,
        updatedAt: new Date().toISOString()
      });
      renderPmItems(deal);
      if (deal.floorPlan) drawPmFloorPlan(deal.floorPlan);
    } catch (err) { showToast("Failed to remove", "error"); }
  }

  on("pm-item-room-filter", "change", function() { renderPmItems(); });
  on("pm-item-cat-filter", "change", function() { renderPmItems(); });

  // Maintenance
  function renderPmMaintenance(deal) {
    if (!deal) deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (!deal) return;
    var pm = deal.propertyMgmt || {};
    var logs = (pm.maintenance || []).slice().sort(function(a, b) { return (b.date || "").localeCompare(a.date || ""); });
    var tbody = document.getElementById("pm-maint-tbody");
    var empty = document.getElementById("pm-maint-empty");
    if (!logs.length) { tbody.innerHTML = ""; empty.style.display = "block"; return; }
    empty.style.display = "none";

    tbody.innerHTML = logs.map(function(m) {
      return '<tr>' +
        '<td>' + escHtml(m.description || "") + '</td>' +
        '<td><span class="badge" style="font-size:0.7rem">' + (PM_MAINT_LABELS[m.type] || m.type || "") + '</span></td>' +
        '<td>' + fmtDealDollar(m.cost) + '</td>' +
        '<td>' + (m.date || "—") + '</td>' +
        '<td><button class="btn btn-secondary btn-sm pm-del-maint" data-maint-id="' + m.id + '" style="padding:0.1rem 0.35rem;font-size:0.65rem;color:#dc2626">&times;</button></td>' +
        '</tr>';
    }).join("");

    tbody.querySelectorAll(".pm-del-maint").forEach(function(btn) {
      btn.addEventListener("click", function() { removePmMaint(btn.dataset.maintId); });
    });
  }

  on("pm-btn-add-maint", "click", function() {
    var f = document.getElementById("pm-maint-form");
    f.style.display = f.style.display === "none" ? "" : "none";
  });

  on("pm-btn-save-maint", "click", async function() {
    var desc = document.getElementById("pm-maint-desc").value.trim();
    var type = document.getElementById("pm-maint-type").value;
    var cost = parseInt(document.getElementById("pm-maint-cost").value) || 0;
    var date = document.getElementById("pm-maint-date").value || new Date().toISOString().slice(0, 10);
    if (!desc) { showToast("Description required", "error"); return; }

    var entry = { id: uid(), description: desc, type: type, cost: cost, date: date };
    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (deal) {
      if (!deal.propertyMgmt) deal.propertyMgmt = {};
      if (!deal.propertyMgmt.maintenance) deal.propertyMgmt.maintenance = [];
      deal.propertyMgmt.maintenance.push(entry);
    }
    try {
      await db.collection("deal-analyzer").doc(pmCurrentId).update({
        "propertyMgmt.maintenance": firebase.firestore.FieldValue.arrayUnion(entry),
        updatedAt: new Date().toISOString()
      });
      ["pm-maint-desc","pm-maint-cost"].forEach(function(id) { document.getElementById(id).value = ""; });
      document.getElementById("pm-maint-form").style.display = "none";
      renderPmMaintenance(deal);
      showToast("Maintenance logged", "success");
    } catch (err) { showToast("Failed to save", "error"); }
  });

  async function removePmMaint(maintId) {
    var deal = allDeals.find(function(d) { return d.id === pmCurrentId; });
    if (!deal || !deal.propertyMgmt) return;
    deal.propertyMgmt.maintenance = (deal.propertyMgmt.maintenance || []).filter(function(m) { return m.id !== maintId; });
    try {
      await db.collection("deal-analyzer").doc(pmCurrentId).update({
        "propertyMgmt.maintenance": deal.propertyMgmt.maintenance,
        updatedAt: new Date().toISOString()
      });
      renderPmMaintenance(deal);
    } catch (err) { showToast("Failed to remove", "error"); }
  }

  // PM filters
  on("pm-filter-status", "change", renderPropertyList);
  on("pm-filter-search", "input", renderPropertyList);

  // ===== ADD PROPERTY =====
  on("pm-btn-add-property", "click", function() {
    var panel = document.getElementById("pm-add-property-panel");
    panel.style.display = panel.style.display === "none" ? "" : "none";
    if (panel.style.display !== "none") populateImportDropdown();
  });

  // Tab switching
  on("pm-add-tab-import", "click", function() {
    document.getElementById("pm-add-import").style.display = "";
    document.getElementById("pm-add-new").style.display = "none";
    this.style.borderBottom = "2px solid var(--accent,#1a3c6e)";
    this.style.color = "";
    document.getElementById("pm-add-tab-new").style.borderBottom = "none";
    document.getElementById("pm-add-tab-new").style.color = "var(--text-muted)";
  });
  on("pm-add-tab-new", "click", function() {
    document.getElementById("pm-add-import").style.display = "none";
    document.getElementById("pm-add-new").style.display = "";
    this.style.borderBottom = "2px solid var(--accent,#1a3c6e)";
    this.style.color = "";
    document.getElementById("pm-add-tab-import").style.borderBottom = "none";
    document.getElementById("pm-add-tab-import").style.color = "var(--text-muted)";
  });

  // Populate import dropdown with deals NOT already in properties
  function populateImportDropdown() {
    var owned = getOwnedProperties();
    var ownedIds = {};
    owned.forEach(function(d) { ownedIds[d.id] = true; });
    // Show deals that aren't already showing in properties
    var available = allDeals.filter(function(d) { return !ownedIds[d.id] && d.status !== "dead"; });
    var select = document.getElementById("pm-import-deal");
    select.innerHTML = '<option value="">-- Select a deal (' + available.length + ' available) --</option>';
    available.forEach(function(d) {
      var p = d.property || {};
      var label = (p.address || "No address") + (p.city ? ", " + p.city : "") + " — " + (STRATEGY_LABELS[p.strategy] || p.strategy || "No strategy") + " — " + (STATUS_LABELS[d.status] || d.status);
      select.innerHTML += '<option value="' + d.id + '">' + escHtml(label) + '</option>';
    });
    document.getElementById("pm-import-preview").style.display = "none";
    document.getElementById("pm-import-confirm").disabled = true;
  }

  // Preview selected deal
  on("pm-import-deal", "change", function() {
    var id = this.value;
    var preview = document.getElementById("pm-import-preview");
    var btn = document.getElementById("pm-import-confirm");
    if (!id) { preview.style.display = "none"; btn.disabled = true; return; }
    var deal = allDeals.find(function(d) { return d.id === id; });
    if (!deal) return;
    var p = deal.property || {};
    var a = deal.analysis || {};
    var hasFp = deal.floorPlan && deal.floorPlan.rooms && deal.floorPlan.rooms.length;
    preview.style.display = "";
    preview.innerHTML = '<strong>' + escHtml(p.address || "—") + '</strong>' +
      (p.city ? ', ' + escHtml(p.city) : '') + (p.state ? ', ' + p.state : '') +
      '<br>' + [p.beds ? p.beds + ' bed' : '', p.baths ? p.baths + ' bath' : '', p.sqft ? p.sqft + ' sqft' : ''].filter(Boolean).join(' · ') +
      '<br>Score: ' + (a.dealScore || '—') + ' | Purchase: ' + fmtDealDollar(p.purchasePrice) + ' | ARV: ' + fmtDealDollar(p.arv) +
      '<br>Floor Plan: ' + (hasFp ? '<span style="color:#059669">Yes (' + deal.floorPlan.rooms.length + ' rooms)</span>' : '<span style="color:#94a3b8">Not yet</span>');
    btn.disabled = false;
  });

  // Import deal as property (mark it so it shows in properties)
  on("pm-import-confirm", "click", async function() {
    var id = document.getElementById("pm-import-deal").value;
    if (!id) return;
    var deal = allDeals.find(function(d) { return d.id === id; });
    if (!deal) return;

    // Set propertyMgmt.managed = true so it always shows in properties list
    if (!deal.propertyMgmt) deal.propertyMgmt = {};
    deal.propertyMgmt.managed = true;

    try {
      await db.collection("deal-analyzer").doc(id).update({
        "propertyMgmt.managed": true,
        updatedAt: new Date().toISOString()
      });
      document.getElementById("pm-add-property-panel").style.display = "none";
      renderPropertyList();
      showToast("Property imported", "success");
    } catch (err) { showToast("Failed to import", "error"); }
  });

  // Create brand new property
  on("pm-new-confirm", "click", async function() {
    var address = document.getElementById("pm-new-address").value.trim();
    if (!address) { showToast("Address is required", "error"); return; }
    var beds = parseInt(document.getElementById("pm-new-beds").value) || 0;
    var baths = parseFloat(document.getElementById("pm-new-baths").value) || 0;
    var sqft = parseInt(document.getElementById("pm-new-sqft").value) || 0;
    var yr = parseInt(document.getElementById("pm-new-year").value) || 0;
    var pp = parseInt(document.getElementById("pm-new-purchase").value) || 0;
    if (beds < 0 || beds > 20) { showToast("Beds should be 0-20", "error"); return; }
    if (baths < 0 || baths > 15) { showToast("Baths should be 0-15", "error"); return; }
    if (sqft < 0) { showToast("Sqft can't be negative", "error"); return; }
    if (yr && (yr < 1800 || yr > new Date().getFullYear() + 2)) { showToast("Year built looks wrong", "error"); return; }
    if (pp < 0) { showToast("Purchase price can't be negative", "error"); return; }

    var newDeal = {
      property: {
        address: address,
        city: document.getElementById("pm-new-city").value.trim(),
        state: document.getElementById("pm-new-state").value.trim().toUpperCase(),
        zip: document.getElementById("pm-new-zip").value.trim(),
        beds: parseInt(document.getElementById("pm-new-beds").value) || 0,
        baths: parseFloat(document.getElementById("pm-new-baths").value) || 0,
        sqft: parseInt(document.getElementById("pm-new-sqft").value) || 0,
        yearBuilt: parseInt(document.getElementById("pm-new-year").value) || 0,
        type: document.getElementById("pm-new-type").value,
        strategy: document.getElementById("pm-new-strategy").value,
        condition: document.getElementById("pm-new-condition").value,
        purchasePrice: parseInt(document.getElementById("pm-new-purchase").value) || 0,
        monthlyRent: parseInt(document.getElementById("pm-new-rent").value) || 0,
        arv: parseInt(document.getElementById("pm-new-arv").value) || 0,
      },
      status: "prospecting",
      propertyMgmt: { managed: true, items: [], maintenance: [] },
      financials: {},
      checklists: {},
      keyDates: {},
      activityLog: [],
      contacts: [],
      documents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    var btn = document.getElementById("pm-new-confirm");
    btn.disabled = true; btn.textContent = "Creating...";
    try {
      var docRef = await db.collection("deal-analyzer").add(newDeal);
      newDeal.id = docRef.id;
      allDeals.unshift(newDeal);
      // Clear form
      ["pm-new-address","pm-new-city","pm-new-state","pm-new-zip","pm-new-beds","pm-new-baths","pm-new-sqft","pm-new-year","pm-new-purchase","pm-new-rent","pm-new-arv"].forEach(function(id) { document.getElementById(id).value = ""; });
      document.getElementById("pm-add-property-panel").style.display = "none";
      renderPropertyList();

      // Ask if they want it in Deal Analyzer for AI analysis
      var addToDa = confirm("Property created!\n\nWould you like to analyze this deal in the Deal Analyzer?\nThis will run AI scoring, comps, and financial analysis.");
      if (addToDa) {
        // Switch to Deal Analyzer and open the deal
        document.querySelectorAll(".nav-item").forEach(function(n) { n.classList.remove("active"); });
        var dealNav = document.querySelector('.nav-item[data-view="deal-analyzer"]');
        if (dealNav) dealNav.classList.add("active");
        document.querySelectorAll(".view").forEach(function(v) { v.classList.remove("active"); });
        document.getElementById("view-deal-analyzer").classList.add("active");
        document.getElementById("topbar-title").textContent = "Deal Analyzer";
        openDealDetail(newDeal.id);
        showToast("Open the deal and click Re-analyze to run AI analysis", "success");
      } else {
        showToast("Property created — open it to add floor plan and details", "success");
      }
    } catch (err) {
      console.error("Create property error:", err);
      showToast("Failed to create property", "error");
    } finally { btn.disabled = false; btn.textContent = "Create Property"; }
  });

})();
