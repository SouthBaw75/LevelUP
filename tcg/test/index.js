// Entry point so `node --test test/` (package.json test script) resolves this
// directory on Node builds that don't expand bare directory args to the test
// runner. Importing the suites registers all their tests in this process.
import './cards.test.js';
import './deck.test.js';
import './rules.test.js';
import './fuzz.test.js';
import './watch.test.js';
