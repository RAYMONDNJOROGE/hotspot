// Configuration: Set your backend API base URL here
// IMPORTANT: In production, this should be your actual deployed backend URL (e.g., 'https://your-backend-app.onrender.com')
const API_BASE_URL =
  window.location.hostname === "localhost" ||
  window.location.hostname === "hotspot-gved.onrender.com"
    ? "https://hotspot-gved.onrender.com/" // Local development
    : "https://hotspot-gved.onrender.com/"; // Production URL
// Ensure the API_BASE_URL is correct for your deployment
// Note: The API_BASE_URL should match the backend server's URL where your payment processing endpoint is hosted.
document.addEventListener("DOMContentLoaded", () => {
  // --- 1. DOM Element Caching ---
  // Get references to all necessary HTML elements once
  const overlay = document.getElementById("overlay"); // New overlay element
  const paymentPopup = document.getElementById("paymentPopup");
  const errorPopup = document.getElementById("errorPopup");
  const successPopup = document.getElementById("successPopup");

  const phoneNumberInput = document.getElementById("phoneNumber");
  const paymentForm = document.getElementById("paymentForm");
  const planDetailsElement = document.getElementById("selectedPlanDetails");
  const subscribeButtons = document.querySelectorAll(".sub-button");

  const closeButton = document.getElementById("closeButton"); // Close button for the main payment popup
  const closeErrorButton = document.getElementById("closeErrorButton"); // Close button for the error popup
  const closeSuccessButton = document.getElementById("closeSuccessButton"); // Close button for the success/processing popup

  const errorMessageElement = document.getElementById("errorMessage"); // Paragraph for displaying specific error messages
  const successMessageElement = document.getElementById("successMessage"); // Paragraph for displaying success/processing messages

  const payButton = document.getElementById("payButton"); // Reference to the Pay button

  // Comments form elements
  const commentsForm = document.getElementById("commentsForm");

  // --- 2. Helper Functions for UI Management ---

  /**
   * Toggles the visibility of a given HTML element and the overlay.
   * @param {HTMLElement} element - The DOM element to show or hide.
   * @param {boolean} isVisible - True to show, false to hide.
   */
  function toggleVisibility(element, isVisible) {
    if (element) {
      if (isVisible) {
        element.classList.remove("hidden");
        overlay.classList.remove("hidden");
      } else {
        element.classList.add("hidden");
        overlay.classList.add("hidden");
      }
    }
  }

  /**
   * Resets the UI by hiding all popups and clearing inputs.
   */
  function resetUI() {
    toggleVisibility(paymentPopup, false);
    toggleVisibility(errorPopup, false);
    toggleVisibility(successPopup, false);
    // The overlay's hidden state is managed by toggleVisibility, no need for redundant calls.

    // Reset specific input fields and messages
    if (phoneNumberInput) {
      phoneNumberInput.value = "";
    }
    if (planDetailsElement) {
      planDetailsElement.textContent = "";
    }
    if (errorMessageElement) {
      errorMessageElement.textContent = ""; // Clear previous error messages
    }
    if (successMessageElement) {
      successMessageElement.textContent = ""; // Clear previous success messages
      successPopup.querySelector("h2").textContent = "Processing..."; // Reset heading
      successPopup.querySelector("#closeSuccessButton").textContent = "OK"; // Reset button text
      successPopup
        .querySelector("#closeSuccessButton")
        .classList.add(
          "bg-green-600",
          "hover:bg-green-700",
          "active:bg-green-800"
        );
      successPopup
        .querySelector("#closeSuccessButton")
        .classList.remove(
          "bg-red-600",
          "hover:bg-red-700",
          "active:bg-red-800"
        );
    }
    // Re-enable the pay button if it was disabled
    if (payButton) {
      payButton.disabled = false;
      payButton.textContent = "Pay";
      payButton.classList.remove("opacity-50", "cursor-not-allowed");
    }
  }

  /**
   * Displays a user message in the dedicated message popup (error or success).
   * @param {string} message - The message to display.
   * @param {'error' | 'success' | 'processing'} type - The type of message to display.
   */
  function displayUserMessage(message, type = "error") {
    resetUI(); // Hide all other popups first

    let targetPopup = errorPopup;
    let targetMessageElement = errorMessageElement;
    let targetHeading = errorPopup.querySelector("h2");
    let targetButton = closeErrorButton;

    // Reset heading colors for consistency before setting new ones
    targetHeading.classList.remove(
      "text-red-400",
      "text-green-400",
      "text-blue-400"
    );
    targetButton.classList.remove(
      "bg-green-600",
      "hover:bg-green-700",
      "active:bg-green-800",
      "bg-red-600",
      "hover:bg-red-700",
      "active:bg-red-800"
    );

    if (type === "success" || type === "processing") {
      targetPopup = successPopup;
      targetMessageElement = successMessageElement;
      targetHeading = successPopup.querySelector("h2");
      targetButton = closeSuccessButton;

      if (type === "success") {
        targetHeading.classList.add("text-green-400"); // Green for success
        targetHeading.textContent = "Payment Successful!";
        targetButton.textContent = "Done";
        targetButton.classList.add(
          "bg-green-600",
          "hover:bg-green-700",
          "active:bg-green-800"
        );
      } else {
        // 'processing'
        targetHeading.classList.add("text-blue-400"); // Blue for processing
        targetHeading.textContent = "Processing...";
        targetButton.textContent = "OK";
        targetButton.classList.add(
          "bg-green-600",
          "hover:bg-green-700",
          "active:bg-green-800"
        );
      }
    } else {
      // 'error'
      targetHeading.classList.add("text-red-400"); // Red for errors
      targetHeading.textContent = "Error!";
      targetButton.textContent = "OK";
      targetButton.classList.add(
        "bg-red-600",
        "hover:bg-red-700",
        "active:bg-red-800"
      );
    }

    if (targetMessageElement) {
      targetMessageElement.textContent = message;
    }

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
      console.error(
        "Error: Missing data-price or data-plan on the clicked subscribe button."
      );
      displayUserMessage(
        "An issue occurred with plan selection. Please try again.",
        "error"
      );
      return;
    }

    // Store data directly on the paymentForm for easier access during submission
    paymentForm.dataset.amount = selectedAmount;
    paymentForm.dataset.plan = selectedPlan;

    if (planDetailsElement) {
      planDetailsElement.textContent = `You selected: ${selectedPlan} for Kes. ${selectedAmount}/-`;
    }

    resetUI(); // Ensure a clean slate
    toggleVisibility(paymentPopup, true);
  }

  /**
   * Validates the phone number format for Kenyan Safaricom numbers (07xxxxxxxxx, 01xxxxxxxxx)
   * @param {string} phone - The phone number string.
   * @returns {string|null} The normalized phone number (254XXXXXXXXX) or null if invalid.
   */
  function validateAndNormalizePhoneNumber(phone) {
    phone = String(phone).trim();

    // Regex for Kenyan mobile numbers: starts with 07, 01, 2547, or 2541 followed by 8 digits.
    const kenyanPhoneRegex = /^(0(1|7)\d{8})$/;

    if (!kenyanPhoneRegex.test(phone)) {
      return null; // Invalid format
    }

    // Normalize to 254 format
    if (phone.startsWith("0")) {
      return "254" + phone.substring(1);
    }
    return phone; // Already in 254 format
  }

  /**
   * Handles the payment form submission (STK push initiation).
   * @param {Event} event - The form submission event.
   */
  async function handlePaymentSubmission(event) {
    event.preventDefault(); // Prevent default form submission

    // Disable the pay button to prevent multiple clicks
    payButton.disabled = true;
    payButton.textContent = "Processing...";
    payButton.classList.add("opacity-50", "cursor-not-allowed");

    let phoneNumber = phoneNumberInput.value;
    const normalizedPhone = validateAndNormalizePhoneNumber(phoneNumber);

    if (!normalizedPhone) {
      displayUserMessage(
        "Invalid phone number. Please enter a valid Kenyan mobile number (e.g., 0712345678 or 0112345678).",
        "error"
      );
      // Button re-enabled by displayUserMessage -> resetUI
      return;
    }
    phoneNumber = normalizedPhone; // Use the normalized phone number

    const amount = paymentForm.dataset.amount;
    const packageDescription = paymentForm.dataset.plan;

    // Double-check amount and plan from data attributes
    if (!amount || !packageDescription) {
      displayUserMessage(
        "Missing payment details. Please re-select your plan.",
        "error"
      );
      // Button re-enabled by displayUserMessage -> resetUI
      return;
    }

    // Show a "processing" message
    displayUserMessage(
      "Your payment request is being sent. Please check your phone for the M-Pesa prompt.",
      "processing"
    );

    const data = {
      amount: parseFloat(amount),
      phone: phoneNumber,
      packageDescription: packageDescription,
    };

    try {
      const response = await fetch(`${API_BASE_URL}/api/process_payment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json", // Indicate that we prefer JSON response
        },
        body: JSON.stringify(data),
      });

      const result = await response.json(); // Always attempt to parse JSON

      if (response.ok) {
        // Check for HTTP 2xx status codes
        console.log("Payment initiated successfully:", result);
        displayUserMessage(
          result.customerMessage ||
            result.message ||
            "Payment request sent! Please check your phone for the M-Pesa prompt.",
          "success"
        );
        // Auto-hide the success message after a few seconds, as the user needs to act on their phone
        setTimeout(resetUI, 7000); // Give user time to see the message and get the prompt
      } else {
        // Server responded with an error (e.g., 400, 500)
        console.error("Server error during payment initiation:", result);
        const errorMessage =
          result.message ||
          "An unexpected error occurred during payment. Please try again or contact support.";
        displayUserMessage("Payment failed: " + errorMessage, "error");
      }
    } catch (error) {
      // Network errors (e.g., server down, no internet)
      console.error(
        "Network or parsing error during payment initiation:",
        error
      );
      displayUserMessage(
        "Could not connect to the payment service. Please check your internet connection or try again later.",
        "error"
      );
    } finally {
      // Button state is managed by displayUserMessage -> resetUI,
      // which will re-enable the button when any message popup is closed.
    }
  }

  /**
   * Handles submission of the comments form.
   * NOTE: This will require a separate backend endpoint to process and store comments.
   * Currently, this just logs to console for the CDN demo.
   * @param {Event} event - The form submission event.
   */
  async function handleCommentsSubmission(event) {
    event.preventDefault(); // Prevent default form submission

    const formData = new FormData(commentsForm);
    const commentsData = {};
    for (let [key, value] of formData.entries()) {
      commentsData[key] = value;
    }

    console.log("Comments Form Submitted:", commentsData);
    // In a real application, you'd send this to your backend, e.g.:
    /*
                try {
                    const response = await fetch(`${API_BASE_URL}/api/comments`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(commentsData)
                    });
                    if (response.ok) {
                        alert("Thank you for your comments!");
                        commentsForm.reset();
                    } else {
                        const errorData = await response.json();
                        alert(`Failed to submit comments: ${errorData.message || 'Unknown error'}`);
                    }
                } catch (error) {
                    console.error("Error submitting comments:", error);
                    alert("Network error: Could not submit comments.");
                }
                */
    alert(
      "Thank you for your comments! (This is a demo, comments are logged to console.)"
    );
    commentsForm.reset(); // Clear the form after submission
  }

  // --- 3. Event Listeners ---

  // Attach click listeners to all subscribe buttons
  subscribeButtons.forEach((button) => {
    button.addEventListener("click", showPaymentPopupHandler);
  });

  // Attach submit listener to the payment form
  if (paymentForm) {
    paymentForm.addEventListener("submit", handlePaymentSubmission);
  }

  // Attach click listeners to close buttons for popups
  if (closeButton) {
    closeButton.addEventListener("click", resetUI);
  }
  if (closeErrorButton) {
    closeErrorButton.addEventListener("click", resetUI);
  }
  if (closeSuccessButton) {
    closeSuccessButton.addEventListener("click", resetUI);
  }
  // Close popups when clicking on the overlay itself
  if (overlay) {
    overlay.addEventListener("click", resetUI);
  }

  // Attach submit listener to the comments form
  if (commentsForm) {
    commentsForm.addEventListener("submit", handleCommentsSubmission);
  }
});
