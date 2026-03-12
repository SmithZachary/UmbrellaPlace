document.addEventListener("DOMContentLoaded", function () {
  // ---------------------------------------------------------------------------
  // 1. DOM references - inputs
  // ---------------------------------------------------------------------------
  var elLoanType = document.getElementById("calc-loan-type");
  var elPurchasePrice = document.getElementById("calc-purchase-price");
  var elRehabBudget = document.getElementById("calc-rehab-budget");
  var elArv = document.getElementById("calc-arv");
  var elLoanAmount = document.getElementById("calc-loan-amount");
  var elInterestRate = document.getElementById("calc-interest-rate");
  var elLoanTerm = document.getElementById("calc-loan-term");
  var elPoints = document.getElementById("calc-points");

  // ---------------------------------------------------------------------------
  // 2. DOM references - conditional containers
  // ---------------------------------------------------------------------------
  var elRehabGroup = document.getElementById("rehab-group");
  var elArvGroup = document.getElementById("arv-group");

  // ---------------------------------------------------------------------------
  // 3. DOM references - result elements
  // ---------------------------------------------------------------------------
  var elResultLtv = document.getElementById("result-ltv");
  var elResultLtvCard = document.getElementById("result-ltv-card");
  var elResultLtc = document.getElementById("result-ltc");
  var elResultLtcCard = document.getElementById("result-ltc-card");
  var elResultArltv = document.getElementById("result-arltv");
  var elResultArltvCard = document.getElementById("result-arltv-card");
  var elResultMonthly = document.getElementById("result-monthly");
  var elResultTotalInterest = document.getElementById("result-total-interest");
  var elResultOrigination = document.getElementById("result-origination");
  var elResultTotalCost = document.getElementById("result-total-cost");
  var elResultProfit = document.getElementById("result-profit");
  var elProfitSection = document.getElementById("profit-section");
  var elTermHint = document.getElementById("term-hint");
  var elRehabLabel = document.getElementById("rehab-label");
  var elPurchasePriceLabel = document.querySelector(
    "label[for='calc-purchase-price']",
  );

  // ---------------------------------------------------------------------------
  // 4. Loan-type configuration
  // ---------------------------------------------------------------------------
  var loanTypeConfig = {
    bridge: {
      showLtv: true,
      showRehab: false,
      showArv: false,
      showProfit: false,
      defaultTerm: 12,
      defaultRate: 10.0,
      defaultPoints: 2.0,
      termHint: "Typical: 6 - 24 months",
      purchasePriceLabel: "Purchase Price ($)",
    },
    "fix-flip": {
      showLtv: true,
      showRehab: true,
      showArv: true,
      showProfit: true,
      defaultTerm: 12,
      defaultRate: 11.0,
      defaultPoints: 2.0,
      termHint: "Typical: 6 - 18 months",
      purchasePriceLabel: "Purchase Price ($)",
    },
    construction: {
      showLtv: false,
      showRehab: true,
      showArv: true,
      showProfit: false,
      defaultTerm: 18,
      defaultRate: 11.5,
      defaultPoints: 2.0,
      termHint: "Typical: 12 - 24 months",
      // FIX 4: Relabel purchase price for construction to reflect land cost
      purchasePriceLabel: "Land / Lot Cost ($)",
    },
    dscr: {
      showLtv: true,
      showRehab: false,
      showArv: false,
      showProfit: false,
      amortizing: true,
      defaultTerm: 360,
      defaultRate: 8.0,
      defaultPoints: 1.0,
      termHint: "Typical: 360 months (30 years)",
      purchasePriceLabel: "Purchase Price ($)",
    },
  };

  // ---------------------------------------------------------------------------
  // 5. parseCurrency - strip non-numeric characters, return float or 0
  // ---------------------------------------------------------------------------
  function parseCurrency(value) {
    var stripped = String(value).replace(/[^0-9.]/g, "");
    var num = parseFloat(stripped);
    return isNaN(num) ? 0 : num;
  }

  // ---------------------------------------------------------------------------
  // 6. formatCurrency - returns dollar formatted string
  // ---------------------------------------------------------------------------
  function formatCurrency(num) {
    return (
      "$" +
      Number(num).toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })
    );
  }

  // ---------------------------------------------------------------------------
  // 7. formatPercent - returns percent formatted string
  // ---------------------------------------------------------------------------
  function formatPercent(num) {
    return Number(num).toFixed(1) + "%";
  }

  // ---------------------------------------------------------------------------
  // 8. setupCurrencyInput - comma-format on blur, raw number on focus
  // ---------------------------------------------------------------------------
  function setupCurrencyInput(inputEl) {
    if (!inputEl) return;

    inputEl.addEventListener("blur", function () {
      var raw = parseCurrency(inputEl.value);
      if (raw > 0) {
        inputEl.value = raw.toLocaleString("en-US", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        });
      }
    });

    inputEl.addEventListener("focus", function () {
      var raw = parseCurrency(inputEl.value);
      if (raw > 0) {
        inputEl.value = raw;
      } else {
        inputEl.value = "";
      }
    });
  }

  setupCurrencyInput(elPurchasePrice);
  setupCurrencyInput(elRehabBudget);
  setupCurrencyInput(elArv);
  setupCurrencyInput(elLoanAmount);

  // ---------------------------------------------------------------------------
  // 9. Loan-type change handler
  // ---------------------------------------------------------------------------
  function handleLoanTypeChange() {
    var type = elLoanType.value;
    var config = loanTypeConfig[type];
    if (!config) return;

    // Show / hide rehab and ARV groups
    if (elRehabGroup) {
      elRehabGroup.hidden = !config.showRehab;
    }
    if (elArvGroup) {
      elArvGroup.hidden = !config.showArv;
    }

    // Update rehab label text
    if (elRehabLabel) {
      elRehabLabel.textContent =
        type === "construction"
          ? "Construction Budget ($)"
          : "Rehab / Construction Budget ($)";
    }

    // FIX 4: Update purchase price label based on loan type
    if (elPurchasePriceLabel) {
      elPurchasePriceLabel.textContent = config.purchasePriceLabel;
    }

    // Show / hide result cards and profit section
    if (elResultLtvCard) {
      elResultLtvCard.hidden = !config.showLtv;
    }
    if (elResultLtcCard) {
      elResultLtcCard.hidden = !config.showRehab;
    }
    if (elResultArltvCard) {
      elResultArltvCard.hidden = !config.showArv;
    }
    if (elProfitSection) {
      elProfitSection.hidden = !config.showProfit;
    }

    // FIX 1: Always apply defaults when loan type changes, not just when empty.
    // This ensures switching loan types always reflects the correct typical values.
    if (elInterestRate) {
      elInterestRate.value = config.defaultRate;
    }
    if (elLoanTerm) {
      elLoanTerm.value = config.defaultTerm;
    }
    if (elPoints) {
      elPoints.value = config.defaultPoints;
    }

    // Update term hint
    if (elTermHint) {
      elTermHint.textContent = config.termHint;
    }

    calculate();
  }

  if (elLoanType) {
    elLoanType.addEventListener("change", handleLoanTypeChange);
  }

  // ---------------------------------------------------------------------------
  // 10. Debounced calculate - 150 ms
  // ---------------------------------------------------------------------------
  var debounceTimer = null;

  function debouncedCalculate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(calculate, 150);
  }

  var calcFields = [
    elLoanType,
    elPurchasePrice,
    elRehabBudget,
    elArv,
    elLoanAmount,
    elInterestRate,
    elLoanTerm,
    elPoints,
  ];

  calcFields.forEach(function (field) {
    if (!field) return;
    field.addEventListener("input", debouncedCalculate);
    field.addEventListener("change", debouncedCalculate);
  });

  // ---------------------------------------------------------------------------
  // 11. calculate() - core computation logic
  // ---------------------------------------------------------------------------
  function calculate() {
    var type = elLoanType ? elLoanType.value : "";
    var config = loanTypeConfig[type] || {};
    var purchasePrice = parseCurrency(
      elPurchasePrice ? elPurchasePrice.value : "",
    );
    var rehab = parseCurrency(elRehabBudget ? elRehabBudget.value : "");
    var arv = parseCurrency(elArv ? elArv.value : "");
    var loan = parseCurrency(elLoanAmount ? elLoanAmount.value : "");
    var rate = parseFloat(elInterestRate ? elInterestRate.value : "") || 0;
    var term = parseFloat(elLoanTerm ? elLoanTerm.value : "") || 0;
    var points = parseFloat(elPoints ? elPoints.value : "") || 0;

    // --- LTV (hidden for construction) ---
    if (elResultLtv) {
      elResultLtv.classList.remove("result-warning", "result-danger");
      if (
        elResultLtvCard &&
        !elResultLtvCard.hidden &&
        loan > 0 &&
        purchasePrice > 0
      ) {
        var ltv = (loan / purchasePrice) * 100;
        elResultLtv.textContent = formatPercent(ltv);
        if (ltv > 90) {
          elResultLtv.classList.add("result-danger");
        } else if (ltv > 80) {
          elResultLtv.classList.add("result-warning");
        }
      } else {
        elResultLtv.textContent = "--";
      }
    }

    // --- LTC (only when LTC card is visible) ---
    if (elResultLtc) {
      if (elResultLtcCard && !elResultLtcCard.hidden) {
        var totalCostBasis = purchasePrice + rehab;
        if (loan > 0 && totalCostBasis > 0) {
          var ltc = (loan / totalCostBasis) * 100;
          elResultLtc.textContent = formatPercent(ltc);
        } else {
          elResultLtc.textContent = "--";
        }
      } else {
        elResultLtc.textContent = "--";
      }
    }

    // --- AR-LTV (only when AR-LTV card is visible) ---
    if (elResultArltv) {
      if (elResultArltvCard && !elResultArltvCard.hidden) {
        if (loan > 0 && arv > 0) {
          var arltv = (loan / arv) * 100;
          elResultArltv.textContent = formatPercent(arltv);
        } else {
          elResultArltv.textContent = "--";
        }
      } else {
        elResultArltv.textContent = "--";
      }
    }

    // --- Monthly payment ---
    var monthlyPayment = 0;
    var isAmortizing = config.amortizing || false;
    if (elResultMonthly) {
      if (loan > 0 && rate > 0) {
        if (isAmortizing && term > 0) {
          // Amortizing (P&I): M = P * [r(1+r)^n] / [(1+r)^n - 1]
          var monthlyRate = rate / 100 / 12;
          var factor = Math.pow(1 + monthlyRate, term);
          monthlyPayment = (loan * (monthlyRate * factor)) / (factor - 1);
        } else {
          // Interest-only: M = P * r / 12
          monthlyPayment = (loan * (rate / 100)) / 12;
        }
        elResultMonthly.textContent = formatCurrency(monthlyPayment);
      } else {
        elResultMonthly.textContent = "--";
      }
      // Update label to reflect payment type
      var monthlyLabel = elResultMonthly.previousElementSibling;
      if (monthlyLabel) {
        monthlyLabel.textContent = isAmortizing
          ? "Monthly Payment (P&I)"
          : "Monthly Interest Payment";
      }
    }

    // --- Total interest ---
    // FIX 3: Add a disclosure note clarifying total interest assumes the full
    // loan term is used. Early payoff on interest-only loans will reduce this.
    var totalInterest = 0;
    if (elResultTotalInterest) {
      if (loan > 0 && rate > 0 && term > 0) {
        if (isAmortizing) {
          // Total interest = total payments minus principal
          totalInterest = monthlyPayment * term - loan;
        } else {
          // Interest-only: assumes full term; early payoff will reduce this amount
          totalInterest = monthlyPayment * term;
        }
        elResultTotalInterest.textContent = formatCurrency(totalInterest);

        // Add/update a disclosure note beneath the total interest card
        var interestCard = elResultTotalInterest.closest(".result-card");
        if (interestCard) {
          var existingNote = interestCard.querySelector(".result-note");
          if (!isAmortizing) {
            if (!existingNote) {
              var note = document.createElement("span");
              note.className = "result-note";
              note.textContent =
                "Assumes full term. Early payoff reduces this.";
              interestCard.appendChild(note);
            }
          } else {
            // Remove note for amortizing loans where total interest is exact
            if (existingNote) {
              existingNote.remove();
            }
          }
        }
      } else {
        elResultTotalInterest.textContent = "--";
      }
    }

    // --- Origination fee ---
    var origFee = 0;
    if (elResultOrigination) {
      if (loan > 0 && points > 0) {
        origFee = loan * (points / 100);
        elResultOrigination.textContent = formatCurrency(origFee);
      } else {
        elResultOrigination.textContent = "--";
      }
    }

    // --- Total loan cost ---
    var totalLoanCost = totalInterest + origFee;
    if (elResultTotalCost) {
      if (loan > 0 && (totalInterest > 0 || origFee > 0)) {
        elResultTotalCost.textContent = formatCurrency(totalLoanCost);
      } else {
        elResultTotalCost.textContent = "--";
      }
    }

    // --- Estimated profit (fix-flip only) ---
    // FIX 2: Account for estimated selling costs (agent commissions, closing
    // costs, transfer taxes) which are typically 7-8% of ARV, and add a
    // disclosure note so users understand what is and isn't included.
    if (elResultProfit) {
      elResultProfit.classList.remove("result-negative");
      if (config.showProfit && elProfitSection && !elProfitSection.hidden) {
        if (arv > 0 && purchasePrice > 0 && totalLoanCost > 0) {
          // Estimated selling costs: agent commissions + closing costs ~7% of ARV
          var sellingCosts = arv * 0.07;
          var profit =
            arv - purchasePrice - rehab - totalLoanCost - sellingCosts;
          elResultProfit.textContent = formatCurrency(profit);
          if (profit < 0) {
            elResultProfit.classList.add("result-negative");
          }

          // Add/update a disclosure note beneath the profit card
          var profitCard = elResultProfit.closest(".result-card");
          if (profitCard) {
            var existingProfitNote = profitCard.querySelector(".result-note");
            if (!existingProfitNote) {
              var profitNote = document.createElement("span");
              profitNote.className = "result-note";
              profitNote.textContent =
                "Includes ~7% selling costs. Excludes holding costs (taxes, insurance, utilities).";
              profitCard.appendChild(profitNote);
            }
          }
        } else {
          elResultProfit.textContent = "--";
        }
      } else {
        elResultProfit.textContent = "--";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Initial run - set up defaults from current loan type selection
  // ---------------------------------------------------------------------------
  handleLoanTypeChange();
});
