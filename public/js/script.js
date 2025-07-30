// --- DOM Element Caching ---
// Select all elements once when the page loads
const overlay = document.querySelector(".overlay");
const paymentPopup = document.querySelector(".payment-popup");
const numFormatErrorPopup = document.querySelector(".num-format-error-popup");
const numOkayPopup = document.querySelector(".num-okay-popup");
const phoneNumberInput = document.getElementById("phoneNumber");
const paymentForm = document.getElementById("paymentForm");
const planDetailsElement = document.getElementById("selectedPlanDetails");
const subscribeButtons = document.querySelectorAll(".sub-button");
const closeButton = document.getElementById("close-button");
const closeErrorPopupBtn = document.querySelector(
  ".num-format-error-popup button"
);

// A helper function to manage element visibility
function toggleVisibility(element, isVisible) {
  if (element) {
    element.style.visibility = isVisible ? "visible" : "hidden";
  }
}

// Function to reset all popups and the input field
function resetUI() {
  toggleVisibility(overlay, false);
  toggleVisibility(paymentPopup, false);
  toggleVisibility(numFormatErrorPopup, false);
  toggleVisibility(numOkayPopup, false);

  if (phoneNumberInput) {
    phoneNumberInput.value = "";
  }
}

// Function to handle the initial popup display
function showPaymentPopup(event) {
  // Get data directly from the clicked button
  const selectedAmount = event.target.dataset.price;
  const selectedPlan = event.target.dataset.plan;

  // Store data in the form for easy access on submission
  paymentForm.dataset.amount = selectedAmount;
  paymentForm.dataset.plan = selectedPlan;

  // Update the payment popup with the selected plan details
  if (planDetailsElement && selectedAmount && selectedPlan) {
    planDetailsElement.textContent = `You selected: ${selectedPlan} for Kes. ${selectedAmount}/-`;
  }

  toggleVisibility(overlay, true);
  toggleVisibility(paymentPopup, true);
}

// Main function to handle payment submission and validation
async function handlePaymentSubmission(event) {
  event.preventDefault();

  const phoneNumber = phoneNumberInput.value;

  // Basic front-end validation
  if (!/^\d{10}$/.test(phoneNumber)) {
    toggleVisibility(paymentPopup, false);
    toggleVisibility(overlay, true);
    toggleVisibility(numFormatErrorPopup, true);
    phoneNumberInput.value = "";
    return; // Stop execution if validation fails
  }

  // Hide the initial popup and show a "processing" message
  toggleVisibility(paymentPopup, false);
  toggleVisibility(overlay, true);
  toggleVisibility(numOkayPopup, true);

  // Prepare the data to send to the back-end
  const data = {
    phoneNumber: phoneNumber,
    amount: paymentForm.dataset.amount,
    packageDescription: paymentForm.dataset.plan,
  };

  try {
    const response = await fetch("/api/process_payment/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    const result = await response.json();

    if (response.ok) {
      console.log("Payment initiated successfully:", result);
      setTimeout(resetUI, 4000);
    } else {
      console.error("Payment failed:", result.error);
      toggleVisibility(numOkayPopup, false);
      toggleVisibility(numFormatErrorPopup, true);
      const errorText = document.querySelector(".num-format-error-popup p");
      if (errorText) {
        errorText.textContent =
          result.error || "An unexpected error occurred. Please try again.";
      }
    }
  } catch (error) {
    console.error("Network error:", error);
    toggleVisibility(numOkayPopup, false);
    toggleVisibility(numFormatErrorPopup, true);
    const errorText = document.querySelector(".num-format-error-popup p");
    if (errorText) {
      errorText.textContent =
        "Could not connect to the server. Please check your internet connection.";
    }
  }
}

// Set up all event listeners after the page has loaded
document.addEventListener("DOMContentLoaded", () => {
  subscribeButtons.forEach((button) => {
    button.addEventListener("click", showPaymentPopup);
  });

  if (paymentForm) {
    paymentForm.addEventListener("submit", handlePaymentSubmission);
  }

  if (closeButton) {
    closeButton.addEventListener("click", resetUI);
  }

  if (closeErrorPopupBtn) {
    closeErrorPopupBtn.addEventListener("click", resetUI);
  }
});
// --- End of DOM Element Caching ---
