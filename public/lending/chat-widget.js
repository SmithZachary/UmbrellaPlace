(function () {
  const CHAT_ENDPOINT =
    "https://us-central1-umbrellaplace-59c7d.cloudfunctions.net/chat";

  // Predefined Q&A
  const QUICK_QUESTIONS = [
    {
      label: "What loan types do you offer?",
      answer:
        "We offer four main products:\n\n• Bridge Loans — short-term, close in 7-14 days\n• Fix & Flip — acquisition + rehab in one loan\n• New Construction — ground-up build financing\n• DSCR Rental Loans — long-term, based on rental income\n\nWant details on any of these?",
    },
    {
      label: "How fast can you close?",
      answer:
        "It depends on the loan type:\n\n• Bridge & Fix-and-Flip — typically 7-14 days\n• New Construction — 2-4 weeks\n• DSCR Rental — 21-30 days\n\nTimelines vary by deal complexity, but speed is one of our biggest strengths.",
    },
    {
      label: "What are your rates?",
      answer:
        "Rates vary by lender, loan type, and deal specifics — things like LTV, property type, borrower experience, and timeline all factor in.\n\nSince we work with 50+ lenders, we shop your deal to find the most competitive terms. The best way to get an accurate quote is to submit your deal details and we'll come back with real numbers.",
    },
    {
      label: "Do you charge upfront fees?",
      answer:
        "No upfront fees — ever. Our brokerage fee is earned at closing and disclosed upfront before you commit. You'll never pay us a dime unless your loan closes.",
    },
    {
      label: "What states do you lend in?",
      answer:
        "We serve 48 states through our network of 50+ private lenders, funds, and institutional capital sources. Just let us know your property location and we'll match you with the right lender.",
    },
  ];

  // Track which questions have been asked
  const askedIndexes = new Set();

  // Build chat widget DOM
  const widget = document.createElement("div");
  widget.id = "chat-widget";
  widget.innerHTML = `
    <button id="chat-toggle" aria-label="Open chat">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </button>
    <div id="chat-panel" class="chat-hidden">
      <div id="chat-header">
        <div id="chat-header-info">
          <img src="./assets/zachpic.png" alt="Zachary Smith" id="chat-avatar" />
          <div>
            <strong>Zachary Smith</strong>
            <span id="chat-subtitle">Loan Advisor</span>
          </div>
        </div>
        <button id="chat-close" aria-label="Close chat">&times;</button>
      </div>
      <div id="chat-messages"></div>
      <form id="chat-input-form">
        <input type="text" id="chat-input" placeholder="Type your question..." autocomplete="off" />
        <button type="submit" id="chat-send" aria-label="Send message">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </form>
    </div>
  `;
  document.body.appendChild(widget);

  const toggle = document.getElementById("chat-toggle");
  const panel = document.getElementById("chat-panel");
  const closeBtn = document.getElementById("chat-close");
  const form = document.getElementById("chat-input-form");
  const input = document.getElementById("chat-input");
  const messagesEl = document.getElementById("chat-messages");

  let chatHistory = [];

  // --- Core DOM helpers ---

  function appendMessage(text, role) {
    const div = document.createElement("div");
    div.className = `chat-msg chat-msg-${role === "user" ? "user" : "bot"}`;
    div.innerHTML = `<p>${escapeHtml(text)}</p>`;
    messagesEl.appendChild(div);
    scrollDown();
    return div;
  }

  function appendBotMessage(text) {
    const div = document.createElement("div");
    div.className = "chat-msg chat-msg-bot";
    div.innerHTML = `<p>${formatBotText(text)}</p>`;
    messagesEl.appendChild(div);
    scrollDown();
    return div;
  }

  function appendTyping() {
    const div = document.createElement("div");
    div.className = "chat-msg chat-msg-bot chat-typing";
    div.innerHTML =
      '<p><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></p>';
    messagesEl.appendChild(div);
    scrollDown();
    return div;
  }

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function formatBotText(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/^• (.+)$/gm, '<span class="chat-bullet">$1</span>')
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");
  }

  // --- Remove any active picks/follow-ups ---

  function clearPicks() {
    messagesEl.querySelectorAll(".chat-picks").forEach((el) => el.remove());
  }

  // --- Render quick-pick buttons ---

  function showPicks() {
    clearPicks();

    const remaining = QUICK_QUESTIONS.map((q, i) => ({ ...q, i })).filter(
      (q) => !askedIndexes.has(q.i)
    );

    const wrap = document.createElement("div");
    wrap.className = "chat-picks";

    if (remaining.length > 0) {
      remaining.forEach((q) => {
        const btn = document.createElement("button");
        btn.className = "chat-quick-btn";
        btn.textContent = q.label;
        btn.addEventListener("click", () => onPickClick(q.i));
        wrap.appendChild(btn);
      });
    } else {
      const note = document.createElement("div");
      note.className = "chat-no-more";
      note.textContent = "No more quick questions — type below to chat.";
      wrap.appendChild(note);
    }

    // Always show "Ask something else"
    const customBtn = document.createElement("button");
    customBtn.className = "chat-quick-btn chat-quick-custom";
    customBtn.textContent = "Ask something else...";
    customBtn.addEventListener("click", () => {
      clearPicks();
      input.focus();
    });
    wrap.appendChild(customBtn);

    messagesEl.appendChild(wrap);
    scrollDown();
  }

  function showFollowUp() {
    clearPicks();

    const remaining = QUICK_QUESTIONS.filter((_, i) => !askedIndexes.has(i));

    const wrap = document.createElement("div");
    wrap.className = "chat-picks";

    if (remaining.length > 0) {
      const moreBtn = document.createElement("button");
      moreBtn.className = "chat-quick-btn";
      moreBtn.textContent = "More questions";
      moreBtn.addEventListener("click", () => showPicks());
      wrap.appendChild(moreBtn);
    }

    const chatBtn = document.createElement("button");
    chatBtn.className = "chat-quick-btn chat-quick-custom";
    chatBtn.textContent = "Ask something else...";
    chatBtn.addEventListener("click", () => {
      clearPicks();
      input.focus();
    });
    wrap.appendChild(chatBtn);

    messagesEl.appendChild(wrap);
    scrollDown();
  }

  function onPickClick(index) {
    const q = QUICK_QUESTIONS[index];
    askedIndexes.add(index);
    clearPicks();

    appendMessage(q.label, "user");
    appendBotMessage(q.answer);

    chatHistory.push({ role: "user", content: q.label });
    chatHistory.push({ role: "assistant", content: q.answer });

    showFollowUp();
  }

  // --- Init ---

  appendBotMessage("Hey! I'm Zach from Umbrella Place. Pick a question below or type your own.");
  showPicks();

  toggle.addEventListener("click", () => {
    panel.classList.remove("chat-hidden");
    toggle.classList.add("chat-hidden");
    input.focus();
  });

  closeBtn.addEventListener("click", () => {
    panel.classList.add("chat-hidden");
    toggle.classList.remove("chat-hidden");
  });

  // --- Free chat ---

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    clearPicks();
    input.value = "";
    appendMessage(text, "user");
    chatHistory.push({ role: "user", content: text });

    const typingEl = appendTyping();
    const sendBtn = document.getElementById("chat-send");
    input.disabled = true;
    sendBtn.disabled = true;

    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: chatHistory }),
      });

      typingEl.remove();
      if (!res.ok) throw new Error("Request failed");

      const data = await res.json();
      const reply = data.reply || "Sorry, I had trouble with that. Please try again.";

      chatHistory.push({ role: "assistant", content: reply });
      appendBotMessage(reply);
    } catch (err) {
      typingEl.remove();
      appendBotMessage(
        "Sorry, I'm having trouble connecting. Call us at (850) 706-0145 or (801) 613-2659."
      );
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  });
})();
