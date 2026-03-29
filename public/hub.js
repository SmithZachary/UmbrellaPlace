// Umbrella Place — Hub
(function () {
  var nav = document.querySelector('.nav');

  // Nav scroll effect
  function onScroll() {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // ===== Contact form submission =====
  var form = document.getElementById('intake-form');
  var formSuccess = document.getElementById('form-success');
  if (!form) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    // Clear errors
    form.querySelectorAll('.error').forEach(function (el) { el.classList.remove('error'); });
    form.querySelectorAll('.hub-field-error').forEach(function (el) { el.hidden = true; });

    var valid = true;

    // Name required
    var firstName = form.querySelector('#firstName');
    if (!firstName.value.trim()) {
      firstName.classList.add('error');
      document.getElementById('firstName-error').hidden = false;
      valid = false;
    }

    // Email required + validation
    var email = form.querySelector('#email');
    if (!email.value.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
      email.classList.add('error');
      document.getElementById('email-error').hidden = false;
      valid = false;
    }

    if (!valid) return;

    // Collect data
    var formData = new FormData(form);
    var data = Object.fromEntries(formData.entries());

    var submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    // reCAPTCHA
    var recaptchaToken = '';
    try {
      if (typeof grecaptcha !== 'undefined') {
        recaptchaToken = await grecaptcha.execute('6LcQNYYsAAAAAJf7s_GzirvDqoTZTuwaCanRVu9F', { action: 'submit_inquiry' });
      }
    } catch (err) {
      console.warn('reCAPTCHA error:', err);
    }
    if (recaptchaToken) data.recaptchaToken = recaptchaToken;

    try {
      var res = await fetch('https://us-central1-umbrellaplace-59c7d.cloudfunctions.net/submitInquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      var result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Submission failed');
      formSuccess.classList.add('visible');
      form.reset();
    } catch (err) {
      console.error('Error saving inquiry:', err);
      alert('Something went wrong. Please try again or contact us directly.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
    }
  });

  // Remove error styling on input
  form.querySelectorAll('input, select, textarea').forEach(function (field) {
    field.addEventListener('input', function () {
      field.classList.remove('error');
    });
  });
})();
