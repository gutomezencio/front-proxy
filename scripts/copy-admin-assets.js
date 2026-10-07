// Copies the admin page's static files next to the compiled admin modules in dist/.
// tsc only emits the .ts files; the HTML, CSS, favicon and vendored Pico CSS are copied as is.
import fs from 'fs';
import { resolve } from 'path';

const from = resolve(import.meta.dirname, '..', 'src', 'admin');
const to = resolve(import.meta.dirname, '..', 'dist', 'admin');

fs.mkdirSync(to, { recursive: true });

for (const name of ['index.html', 'app.css', 'favicon.svg', 'vendor']) {
  fs.cpSync(resolve(from, name), resolve(to, name), { recursive: true });
}
