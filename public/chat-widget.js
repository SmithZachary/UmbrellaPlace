(function () {
  const CHAT_ENDPOINT =
    "https://us-central1-umbrellaplace-59c7d.cloudfunctions.net/chat";

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
      <div id="chat-messages">
        <div class="chat-msg chat-msg-bot">
          <p>Hey! I'm Zach, one of the managing partners here at Umbrella Place. I can answer questions about bridge loans, fix & flip financing, DSCR rentals, new construction — or help you figure out which loan type fits your deal. What can I help with?</p>
        </div>
      </div>
      <form id="chat-input-form">
        <input type="text" id="chat-input" placeholder="Ask about loan options..." autocomplete="off" />
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

  // Chat history for API context
  let chatHistory = [];

  toggle.addEventListener("click", () => {
    panel.classList.remove("chat-hidden");
    toggle.classList.add("chat-hidden");
    input.focus();
  });

  closeBtn.addEventListener("click", () => {
    panel.classList.add("chat-hidden");
    toggle.classList.remove("chat-hidden");
  });

  function appendMessage(text, role) {
    const div = document.createElement("div");
    div.className = `chat-msg chat-msg-${role === "user" ? "user" : "bot"}`;
    div.innerHTML = `<p>${escapeHtml(text)}</p>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function appendTyping() {
    const div = document.createElement("div");
    div.className = "chat-msg chat-msg-bot chat-typing";
    div.innerHTML =
      '<p><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></p>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

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
      appendMessage(reply, "bot");
    } catch (err) {
      typingEl.remove();
      appendMessage(
        "Sorry, I'm having trouble connecting right now. Feel free to call us directly at (850) 706-0145 or (801) 613-2659.",
        "bot"
      );
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  });
})();
