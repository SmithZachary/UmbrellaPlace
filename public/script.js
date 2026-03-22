// Mobile menu toggle
const mobileMenu = document.querySelector(".mobile-menu");
const navLinks = document.querySelector(".nav-links");
const nav = document.querySelector("nav");

mobileMenu.addEventListener("click", () => {
  const isOpen = navLinks.classList.toggle("active");
  mobileMenu.setAttribute("aria-expanded", isOpen);
});

document.querySelectorAll(".nav-links a").forEach((link) => {
  link.addEventListener("click", () => {
    navLinks.classList.remove("active");
  });
});

// Navbar scroll effect
window.addEventListener("scroll", () => {
  if (window.scrollY > 50) {
    nav.classList.add("scrolled");
  } else {
    nav.classList.remove("scrolled");
  }
});

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener("click", function (e) {
    e.preventDefault();
    const targetId = this.getAttribute("href");
    const targetSection = document.querySelector(targetId);
    if (targetSection) {
      const navHeight = nav.offsetHeight;
      window.scrollTo({
        top: targetSection.offsetTop - navHeight,
        behavior: "smooth",
      });
    }
  });
});

// Offset hash scroll on page load (cross-page links like calculator → index.html#contact)
if (window.location.hash) {
  setTimeout(() => {
    const target = document.querySelector(window.location.hash);
    if (target) {
      window.scrollTo({
        top: target.offsetTop - nav.offsetHeight,
        behavior: "smooth",
      });
    }
  }, 100);
}

// Scroll-triggered animations using IntersectionObserver
const animatedElements = document.querySelectorAll(
  ".animate, .animate-left, .animate-right, .animate-scale"
);

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  },
  {
    threshold: 0.15,
    rootMargin: "0px 0px -40px 0px",
  }
);

animatedElements.forEach((el) => observer.observe(el));

// FAQ accordion
document.querySelectorAll(".faq-question").forEach((btn) => {
  btn.addEventListener("click", () => {
    const item = btn.parentElement;
    const isOpen = item.classList.contains("open");
    // Close all
    document.querySelectorAll(".faq-item.open").forEach((el) => {
      el.classList.remove("open");
      el.querySelector(".faq-question").setAttribute("aria-expanded", "false");
    });
    // Toggle clicked
    if (!isOpen) {
      item.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    }
  });
});

// Counter animation for hero stats
function animateCounter(el, target, suffix = "") {
  const duration = 1800;
  const start = performance.now();

  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // Ease-out cubic
    const ease = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(ease * target);

    el.textContent = current.toLocaleString() + suffix;

    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}

// Observe hero stats to trigger counter animation
const statsSection = document.querySelector(".hero-stats");
let statsCounted = false;

const statsObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && !statsCounted) {
        statsCounted = true;

        const statNumbers = document.querySelectorAll(".stat-number");
        statNumbers.forEach((el) => {
          const text = el.textContent;
          if (text.includes("-")) {
            // "7-14" - just fade it in, don't count
          } else {
            const hasPlus = text.includes("+");
            const num = parseInt(text.replace(/[^0-9]/g, ""));
            const dur = 1800;
            const s = performance.now();
            const tick = (now) => {
              const p = Math.min((now - s) / dur, 1);
              const ease = 1 - Math.pow(1 - p, 3);
              el.textContent = Math.round(ease * num).toLocaleString() + (hasPlus ? "+" : "");
              if (p < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
        });

        statsObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.5 }
);

if (statsSection) {
  statsObserver.observe(statsSection);
}

// Dynamic loan type options
const loanTypeOptions = {
  bridge: {
    propertyTypes: ["Single Family (1-4)", "Multi-Family (5+)", "Mixed-Use", "Land"],
    purposes: ["Purchase", "Refinance", "Partner Buyout", "Payoff Existing Lien"],
  },
  "fix-flip": {
    propertyTypes: ["Single Family", "Duplex", "Triplex", "Fourplex", "Small Multi-Family"],
    purposes: ["Purchase + Rehab", "Rehab Only", "Refinance After Rehab"],
  },
  construction: {
    propertyTypes: ["Single Family", "Townhomes", "Multi-Family", "Mixed-Use", "ADU"],
    purposes: ["Ground-Up Build", "Tear Down & Rebuild", "Major Renovation", "Lot Development"],
  },
  dscr: {
    propertyTypes: ["Single Family", "Duplex", "Triplex", "Fourplex", "Multi-Family (5+)", "Short-Term Rental"],
    purposes: ["Purchase", "Rate & Term Refinance", "Cash-Out Refinance", "Portfolio Consolidation"],
  },
};

const loanTypeSelect = document.getElementById("loanType");
const dynamicFields = document.getElementById("dynamic-fields");
const propertyTypeSelect = document.getElementById("propertyType");
const loanPurposeSelect = document.getElementById("loanPurpose");

if (loanTypeSelect) {
  loanTypeSelect.addEventListener("change", function () {
    const selected = this.value;
    const options = loanTypeOptions[selected];

    if (options) {
      // Populate property types
      propertyTypeSelect.innerHTML = '<option value="" disabled selected>Select property type</option>';
      options.propertyTypes.forEach((type) => {
        const opt = document.createElement("option");
        opt.value = type.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        opt.textContent = type;
        propertyTypeSelect.appendChild(opt);
      });

      // Populate purposes
      loanPurposeSelect.innerHTML = '<option value="" disabled selected>Select purpose</option>';
      options.purposes.forEach((purpose) => {
        const opt = document.createElement("option");
        opt.value = purpose.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        opt.textContent = purpose;
        loanPurposeSelect.appendChild(opt);
      });

      dynamicFields.hidden = false;
      propertyTypeSelect.required = true;
      loanPurposeSelect.required = true;
    } else {
      // "other" - hide dynamic fields
      dynamicFields.hidden = true;
      propertyTypeSelect.required = false;
      loanPurposeSelect.required = false;
    }

    // Show ARV field only for fix & flip
    const arvGroup = document.getElementById("arv-group");
    if (arvGroup) {
      arvGroup.hidden = selected !== "fix-flip";
    }
  });
}

// Currency input formatting — strip non-digits, format with commas, prefix $
function setupCurrencyInput(el) {
  if (!el) return;
  el.addEventListener("input", function () {
    const raw = this.value.replace(/[^0-9]/g, "");
    if (raw === "") {
      this.value = "";
      return;
    }
    this.value = "$" + parseInt(raw, 10).toLocaleString("en-US");
  });
  // Also handle paste
  el.addEventListener("paste", function () {
    setTimeout(() => {
      const raw = this.value.replace(/[^0-9]/g, "");
      if (raw === "") {
        this.value = "";
        return;
      }
      this.value = "$" + parseInt(raw, 10).toLocaleString("en-US");
    }, 0);
  });
}

setupCurrencyInput(document.getElementById("loanAmount"));
setupCurrencyInput(document.getElementById("afterRepairValue"));

// Intake form handling
const form = document.getElementById("intake-form");
const formSuccess = document.getElementById("form-success");

if (form) {
  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    // Clear previous errors
    form.querySelectorAll(".error").forEach((el) => el.classList.remove("error"));
    form.querySelectorAll(".field-error").forEach((el) => (el.hidden = true));
    const contactHint = document.getElementById("contact-hint");
    contactHint.hidden = true;

    let valid = true;

    // First name is required
    const firstName = form.querySelector("#firstName");
    if (!firstName.value.trim()) {
      firstName.classList.add("error");
      document.getElementById("firstName-error").hidden = false;
      valid = false;
    }

    // At least one of email or phone is required
    const email = form.querySelector("#email");
    const phone = form.querySelector("#phone");
    if (!email.value.trim() && !phone.value.trim()) {
      email.classList.add("error");
      phone.classList.add("error");
      contactHint.hidden = false;
      valid = false;
    }

    // Basic email validation if provided
    if (email.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
      email.classList.add("error");
      document.getElementById("email-error").hidden = false;
      valid = false;
    }

    if (!valid) return;

    // Collect form data
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Clean currency fields — store raw numeric string
    if (data.loanAmount) data.loanAmount = data.loanAmount.replace(/[^0-9]/g, "");
    if (data.afterRepairValue) data.afterRepairValue = data.afterRepairValue.replace(/[^0-9]/g, "");

    // Disable submit button while saving
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    // reCAPTCHA verification
    const siteKey = "6LcQNYYsAAAAAJf7s_GzirvDqoTZTuwaCanRVu9F";
    let recaptchaToken = "";
    try {
      if (typeof grecaptcha !== "undefined") {
        recaptchaToken = await grecaptcha.execute(siteKey, { action: "submit_inquiry" });
      }
    } catch (err) {
      console.warn("reCAPTCHA error:", err);
    }
    if (recaptchaToken) {
      data.recaptchaToken = recaptchaToken;
    }

    try {
      const res = await fetch("https://us-central1-umbrellaplace-59c7d.cloudfunctions.net/submitInquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Submission failed");
      formSuccess.hidden = false;
      form.reset();
    } catch (err) {
      console.error("Error saving inquiry:", err);
      alert("Something went wrong. Please try again or contact us directly.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit for Review";
    }
  });

  // Remove error styling on input
  form.querySelectorAll("input, select, textarea").forEach((field) => {
    field.addEventListener("input", () => {
      field.classList.remove("error");
      if (field.id === "email" || field.id === "phone") {
        document.getElementById("contact-hint").hidden = true;
      }
    });
  });
}
