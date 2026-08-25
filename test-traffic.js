const http = require('http');

let errors = 0;
let success = 0;
let running = true;
let lastErr = null;
let lastStatus = null;

const makeRequest = () => {
  if (!running) return;
  http.get('http://127.0.0.1/api/result/26010001', (res) => {
    if (res.statusCode === 200 || res.statusCode === 202) {
      success++;
    } else {
      errors++;
      lastStatus = res.statusCode;
    }
    // Discard response body to free memory
    res.on('data', () => {});
    res.on('end', () => {
      setTimeout(makeRequest, 10); // next request
    });
  }).on('error', (err) => {
    errors++;
    lastErr = err.message;
    setTimeout(makeRequest, 10);
  });
};

// Start 20 concurrent loops
for (let i = 0; i < 20; i++) {
  makeRequest();
}

setTimeout(() => {
  running = false;
  console.log(`Test finished. Success: ${success}, Errors: ${errors}`);
  if (lastErr) console.log(`Last Error: ${lastErr}`);
  if (lastStatus) console.log(`Last Status: ${lastStatus}`);
  process.exit(errors > 0 ? 1 : 0);
}, 20000); // run for 20 seconds
