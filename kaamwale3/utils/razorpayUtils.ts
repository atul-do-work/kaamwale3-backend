export const escapeJsString = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '""';
  }
  return JSON.stringify(String(value));
};

export const buildRazorpayCheckoutHtml = ({
  keyId,
  orderId,
  amount,
  name,
  description,
  prefillName,
  prefillEmail,
  prefillContact,
  successEvent = 'deposit_success',
  failureEvent = 'deposit_failed',
  themeColor = '#1a2f4d',
}: {
  keyId: string;
  orderId: string;
  amount: number;
  name: string;
  description: string;
  prefillName: string;
  prefillEmail: string;
  prefillContact: string;
  successEvent?: string;
  failureEvent?: string;
  themeColor?: string;
}) => `
<!DOCTYPE html>
<html>
<head>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <style>
    body { margin: 0; padding: 0; background: #f5f5f5; }
    #checkout-container { display: flex; justify-content: center; align-items: center; height: 100vh; }
  </style>
</head>
<body>
  <div id="checkout-container">
    <p>Opening Razorpay Checkout...</p>
  </div>
  <script>
    var options = {
      "key": ${escapeJsString(keyId)},
      "amount": ${amount},
      "currency": "INR",
      "name": ${escapeJsString(name)},
      "description": ${escapeJsString(description)},
      "order_id": ${escapeJsString(orderId)},
      "handler": function (response){
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: ${escapeJsString(successEvent)},
          paymentId: response.razorpay_payment_id,
          orderId: response.razorpay_order_id,
          signature: response.razorpay_signature
        }));
      },
      "prefill": {
        "name": ${escapeJsString(prefillName)},
        "email": ${escapeJsString(prefillEmail)},
        "contact": ${escapeJsString(prefillContact)}
      },
      "theme": {
        "color": ${escapeJsString(themeColor)}
      }
    };
    var rzp1 = new Razorpay(options);
    rzp1.open();
    rzp1.on('payment.failed', function (response){
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: ${escapeJsString(failureEvent)},
        error: response.error.description
      }));
    });
  </script>
</body>
</html>
`;

export const isAllowedRazorpayUrl = (url: string): boolean => {
  if (url.startsWith('data:')) return true;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)razorpay\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
};
