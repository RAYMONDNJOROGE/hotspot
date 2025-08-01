// Configuration: Set your backend API base URL here
// IMPORTANT: In production, this should be your actual deployed backend URL
const API_BASE_URL = "https://hotspot-gved.onrender.com";

document.addEventListener("DOMContentLoaded", () => {
  // --- 1. DOM Element Caching & Initial State ---
  const overlay = document.getElementById("overlay");
  const paymentPopup = document.getElementById("paymentPopup");
  const errorPopup = document.getElementById("errorPopup");
  const successPopup = document.getElementById("successPopup");

  const phoneNumberInput = document.getElementById("phoneNumber");
  const paymentForm = document.getElementById("paymentForm");
  const planDetailsElement = document.getElementById("selectedPlanDetails");
  const subscribeButtons = document.querySelectorAll(".sub-button");

  const closeButton = document.getElementById("closeButton");
  const closeErrorButton = document.getElementById("closeErrorButton");
  const closeSuccessButton = document.getElementById("closeSuccessButton");

  const errorMessageElement = document.getElementById("errorMessage");
  const successMessageElement = document.getElementById("successMessage");

  const payButton = document.getElementById("payButton");

  // Comments form elements
  const commentsForm = document.getElementById("commentsForm");
  const commentsSubmitButton = commentsForm.querySelector(
    'button[type="submit"]'
  );
  // Use the class selector for the reset button for consistency
  const commentsResetButton = commentsForm.querySelector(".com-res");
  const commentsRequiredFields = commentsForm.querySelectorAll("[required]");

  // The hidden Mikrotik login form elements
  const mikrotikLoginForm = document.forms.sendin;
  const mikrotikUsernameInput = document.getElementById("mikrotik_username");
  const mikrotikPasswordInput = document.getElementById("mikrotik_password");

  // Global variables for URL parameters and polling
  let pollingInterval = null;
  let macAddress = null;
  let mikrotikLoginUrl = null;
  let checkoutRequestID = null;

  // Dynamically set the current year in the footer
  const currentYearSpan = document.getElementById("currentYear");
  if (currentYearSpan) {
    currentYearSpan.textContent = new Date().getFullYear();
  }

  // --- 2. Helper Functions for UI Management & Core Logic ---

  /**
   * Extracts URL parameters.
   * @param {string} name - The name of the parameter.
   * @returns {string} The decoded value of the parameter.
   */
  function getUrlParameter(name) {
    name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
    const regex = new RegExp("[\\?&]" + name + "=([^&#]*)");
    const results = regex.exec(location.search);
    return results === null
      ? ""
      : decodeURIComponent(results[1].replace(/\+/g, " "));
  }

  /**
   * Toggles the visibility of a given HTML element and the overlay.
   * @param {HTMLElement} element - The DOM element to show or hide.
   * @param {boolean} isVisible - True to show, false to hide.
   */
  function toggleVisibility(element, isVisible) {
    if (element) {
      element.classList.toggle("hidden", !isVisible);
      overlay.classList.toggle("hidden", !isVisible);
    }
  }

  /**
   * Resets the UI by hiding all popups and clearing inputs.
   */
  function resetUI() {
    toggleVisibility(paymentPopup, false);
    toggleVisibility(errorPopup, false);
    toggleVisibility(successPopup, false);

    if (phoneNumberInput) phoneNumberInput.value = "";
    if (planDetailsElement) planDetailsElement.textContent = "";
    if (errorMessageElement) errorMessageElement.textContent = "";
    if (successMessageElement) successMessageElement.textContent = "";

    // Reset all popup states
    if (successPopup) {
      const h2 = successPopup.querySelector("h2");
      h2.classList.remove("text-red-400", "text-green-400", "text-blue-400");
    }

    if (payButton) {
      payButton.disabled = false;
      payButton.textContent = "Pay";
      payButton.classList.remove("opacity-50", "cursor-not-allowed");
    }

    if (commentsSubmitButton) {
      commentsSubmitButton.disabled = false;
      commentsSubmitButton.textContent = "Submit";
      commentsSubmitButton.classList.remove("opacity-50", "cursor-not-allowed");
    }

    commentsRequiredFields.forEach((field) => {
      field.classList.remove("border-red-500");
    });

    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  /**
   * Displays a user message in the dedicated message popup (error or success).
   * @param {string} message - The message to display.
   * @param {'error' | 'success' | 'processing'} type - The type of message to display.
   */
  function displayUserMessage(message, type = "error") {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    resetUI();

    let targetPopup, targetMessageElement, targetHeading, targetButton;

    if (type === "success" || type === "processing") {
      targetPopup = successPopup;
      targetMessageElement = successMessageElement;
      targetHeading = successPopup.querySelector("h2");
      targetButton = closeSuccessButton;

      if (type === "success") {
        targetHeading.textContent = "Success!";
        targetHeading.classList.add("text-green-400");
        targetButton.textContent = "Done";
      } else {
        targetHeading.textContent = "Processing...";
        targetHeading.classList.add("text-blue-400");
        targetButton.textContent = "OK";
      }
    } else {
      targetPopup = errorPopup;
      targetMessageElement = errorMessageElement;
      targetHeading = errorPopup.querySelector("h2");
      targetButton = closeErrorButton;
      targetHeading.textContent = "Error!";
      targetHeading.classList.add("text-red-400");
      targetButton.textContent = "OK";
      // Set error button styles
      targetButton.classList.remove(
        "bg-green-600",
        "hover:bg-green-700",
        "active:bg-green-800"
      );
      targetButton.classList.add(
        "bg-red-600",
        "hover:bg-red-700",
        "active:bg-red-800"
      );
    }

    if (targetMessageElement) targetMessageElement.textContent = message;
    toggleVisibility(targetPopup, true);
  }

  /**
   * Handles the display of the payment popup when a subscribe button is clicked.
   * @param {Event} event - The click event.
   */
  function showPaymentPopupHandler(event) {
    const selectedAmount = event.target.dataset.price;
    const selectedPlan = event.target.dataset.plan;

    if (!selectedAmount || !selectedPlan) {
      displayUserMessage(
        "An issue occurred with plan selection. Please try again.",
        "error"
      );
      return;
    }

    paymentForm.dataset.amount = selectedAmount;
    paymentForm.dataset.plan = selectedPlan;

    if (planDetailsElement) {
      planDetailsElement.textContent = `You selected: ${selectedPlan} for Kes. ${selectedAmount}/-`;
    }

    resetUI();
    toggleVisibility(paymentPopup, true);
  }

  /**
   * Validates and normalizes a phone number.
   * @param {string} phone - The phone number string.
   * @returns {string|null} The normalized phone number (254XXXXXXXXX) or null if invalid.
   */
  function validateAndNormalizePhoneNumber(phone) {
    phone = String(phone).trim();
    const kenyanPhoneRegex = /^(0(1|7)\d{8})$/;
    if (!kenyanPhoneRegex.test(phone)) {
      return null;
    }
    return "254" + phone.substring(1);
  }

  /**
   * Polls the backend for the payment status.
   */
  async function pollPaymentStatus() {
    if (!checkoutRequestID) return;

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/check_payment_status/${checkoutRequestID}`
      );
      const result = await response.json();

      // Check if the status is final (Completed, Cancelled, or Failed)
      if (
        ["Completed", "Cancelled", "Failed", "Timeout"].includes(result.status)
      ) {
        clearInterval(pollingInterval);
        pollingInterval = null;

        if (result.status === "Completed") {
          displayUserMessage(
            "Payment successful! Logging you in...",
            "processing"
          );
          // Call the new Mikrotik login function
          await mikrotikLogin();
        } else {
          displayUserMessage(`Payment failed: ${result.message}`, "error");
        }
      }
    } catch (error) {
      clearInterval(pollingInterval);
      pollingInterval = null;
      displayUserMessage(
        "An error occurred while checking payment status. Please try again later.",
        "error"
      );
    }
  }

  /**
   * Logs the user into the Mikrotik router by submitting the hidden form.
   */
  async function mikrotikLogin() {
    const phoneNumber = phoneNumberInput.value;
    const selectedPlan = paymentForm.dataset.plan;

    try {
      const authResponse = await fetch(`${API_BASE_URL}/api/mikrotik_auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: phoneNumber,
          macAddress: macAddress,
          package: selectedPlan,
        }),
      });
      const authResult = await authResponse.json();

      if (authResult.success) {
        // If backend authentication is successful, submit the Mikrotik form
        mikrotikUsernameInput.value = phoneNumber;
        mikrotikPasswordInput.value = "payment-user";
        mikrotikLoginForm.action = mikrotikLoginUrl;
        mikrotikLoginForm.submit();
      } else {
        displayUserMessage(
          "Failed to log in. Please contact support.",
          "error"
        );
      }
    } catch (error) {
      console.error("Mikrotik login failed:", error);
      displayUserMessage(
        "An error occurred during login. Please contact support.",
        "error"
      );
    }
  }

  /**
   * Handles the payment form submission (STK push initiation).
   * @param {Event} event - The form submission event.
   */
  async function handlePaymentSubmission(event) {
    event.preventDefault();

    payButton.disabled = true;
    payButton.textContent = "Processing...";
    payButton.classList.add("opacity-50", "cursor-not-allowed");

    const normalizedPhone = validateAndNormalizePhoneNumber(
      phoneNumberInput.value
    );

    if (!normalizedPhone) {
      displayUserMessage(
        "Invalid phone number. Please enter a valid Kenyan mobile number starting with **07** or **01** (e.g., 0712345678).",
        "error"
      );
      return;
    }

    const amount = paymentForm.dataset.amount;
    const packageDescription = paymentForm.dataset.plan;

    if (!amount || !packageDescription) {
      displayUserMessage(
        "Missing payment details. Please re-select your plan.",
        "error"
      );
      return;
    }

    displayUserMessage(
      "Your payment request is being sent. Please check your phone for the M-Pesa prompt.",
      "processing"
    );

    const data = {
      amount: parseFloat(amount),
      phone: normalizedPhone,
      packageDescription: packageDescription,
    };

    try {
      const response = await fetch(`${API_BASE_URL}/api/process_payment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(data),
      });
      const result = await response.json();

      if (response.ok && result.checkoutRequestID) {
        checkoutRequestID = result.checkoutRequestID;
        // Poll every 3 seconds for the final status
        pollingInterval = setInterval(pollPaymentStatus, 3000);
      } else {
        const errorMessage =
          result.message ||
          "An unexpected error occurred during payment. Please try again or contact support.";
        displayUserMessage("Payment failed: " + errorMessage, "error");
      }
    } catch (error) {
      displayUserMessage(
        "Could not connect to the payment service. Please check your internet connection or try again later.",
        "error"
      );
    }
  }

  /**
   * Handles submission of the comments form.
   * @param {Event} event - The form submission event.
   */
  async function handleCommentsSubmission(event) {
    event.preventDefault();

    let allFilled = true;
    commentsRequiredFields.forEach((field) => {
      if (!field.value.trim()) {
        allFilled = false;
        field.classList.add("border-red-500");
      } else {
        field.classList.remove("border-red-500");
      }
    });

    if (!allFilled) {
      displayUserMessage(
        "Please fill in all required fields before submitting.",
        "error"
      );
      return;
    }

    commentsSubmitButton.disabled = true;
    commentsSubmitButton.textContent = "Submitting...";
    commentsSubmitButton.classList.add("opacity-50", "cursor-not-allowed");

    const formData = new FormData(commentsForm);
    const commentsData = {};
    for (let [key, value] of formData.entries()) {
      commentsData[key] = value;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/submit_comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(commentsData),
      });
      const result = await response.json();

      if (response.ok) {
        displayUserMessage(
          result.message ||
            "Thank you for your comments! We'll get back to you soon.",
          "success"
        );
        commentsForm.reset();
      } else {
        displayUserMessage(
          `Failed to submit comments: ${result.message || "Unknown error"}`,
          "error"
        );
      }
    } catch (error) {
      displayUserMessage(
        "Network error: Could not submit comments. Please try again later.",
        "error"
      );
    } finally {
      // Restore button state regardless of success or failure
      commentsSubmitButton.disabled = false;
      commentsSubmitButton.textContent = "Submit";
      commentsSubmitButton.classList.remove("opacity-50", "cursor-not-allowed");
    }
  }

  // --- 3. Initial Setup & Event Listeners ---
  function init() {
    macAddress = getUrlParameter("mac");
    mikrotikLoginUrl = getUrlParameter("link-login-only");

    if (macAddress) {
      document.getElementById("mac-address").textContent = macAddress;
      document.getElementById("mac-container").classList.remove("hidden");
    }

    subscribeButtons.forEach((button) => {
      button.addEventListener("click", showPaymentPopupHandler);
    });

    if (paymentForm) {
      paymentForm.addEventListener("submit", handlePaymentSubmission);
    }

    if (closeButton) {
      closeButton.addEventListener("click", resetUI);
    }
    if (closeErrorButton) {
      closeErrorButton.addEventListener("click", resetUI);
    }
    if (closeSuccessButton) {
      closeSuccessButton.addEventListener("click", resetUI);
    }
    if (overlay) {
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          resetUI();
        }
      });
    }

    if (commentsForm) {
      commentsForm.addEventListener("submit", handleCommentsSubmission);
    }

    if (commentsResetButton) {
      commentsResetButton.addEventListener("click", () => {
        commentsForm.reset();
        resetUI();
      });
    }
  }

  // --- 4. Additional Enhancements ---

  // Real-time validation feedback on input
  commentsForm.addEventListener("input", (event) => {
    const target = event.target;
    if (target.matches("[required]")) {
      target.classList.toggle("border-red-500", !target.value.trim());
    }
  });

  // Toggle submit button state based on required fields
  commentsForm.addEventListener("input", () => {
    const allFilled = [...commentsRequiredFields].every((field) =>
      field.value.trim()
    );

    if (allFilled) {
      commentsSubmitButton.disabled = false;
      commentsSubmitButton.textContent = "Submit";
      commentsSubmitButton.classList.remove("opacity-50", "cursor-not-allowed");
    } else {
      commentsSubmitButton.disabled = true;
      commentsSubmitButton.textContent = "Fill all fields";
      commentsSubmitButton.classList.add("opacity-50", "cursor-not-allowed");
    }
  });

  // Accessibility Enhancements (Focus State)
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (
      target.matches(
        'input, textarea, select, button, a[href], [tabindex]:not([tabindex="-1"])'
      )
    ) {
      target.classList.add(
        "focus:outline-none",
        "focus:ring-2",
        "focus:ring-blue-400"
      );
    }
  });
  document.addEventListener("focusout", (event) => {
    const target = event.target;
    target.classList.remove(
      "focus:outline-none",
      "focus:ring-2",
      "focus:ring-blue-400"
    );
  });

  // Scroll-to-top button
  const scrollToTopButton = document.createElement("button");
  scrollToTopButton.textContent = "↑";
  scrollToTopButton.className =
    "fixed bottom-4 right-4 bg-blue-600 text-white rounded-full w-10 h-10 flex items-center justify-center shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400";
  scrollToTopButton.style.display = "none";
  document.body.appendChild(scrollToTopButton);
  window.addEventListener("scroll", () => {
    scrollToTopButton.style.display = window.scrollY > 300 ? "flex" : "none";
  });
  scrollToTopButton.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // Initialize the script
  init();
});
