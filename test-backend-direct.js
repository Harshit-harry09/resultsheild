const http = require('http');

let errors = 0;
let success = 0;
let running = true;
const targetUrl = 'http://resultshield-backend-3:3000/api/result/26010001';

const makeRequest = () => {
  if (!running) return;
  http.get(targetUrl, (res) => {
    if (res.statusCode === 200 || res.statusCode === 202) {
      success++;
    } else {
      errors++;
    }
    res.on('data', () => {});
    res.on('end', () => {
      setTimeout(makeRequest, 50); // space them slightly
    });
  }).on('error', (err) => {
    // Only count as error if it happened while running
    if (running) {
      errors++;
      setTimeout(makeRequest, 50);
    }
  });
};

for (let i = 0; i < 5; i++) {
  makeRequest();
}

// Run for 15 seconds
setTimeout(() => {
  running = false;
  console.log(`Test finished. Success: ${success}, Errors: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}, 15000);
