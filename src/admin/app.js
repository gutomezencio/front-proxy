// front-proxy admin page. Plain ES module, no build step. The server validates everything
// again; the checks here only give faster feedback. Data is rendered with textContent only.

import { hydrateIcons, icon } from './icons.js';

const token = document.querySelector('meta[name="front-proxy-token"]').content;

const $ = (selector) => document.querySelector(selector);

// Mirrors src/hosts-validation.js.
const hostLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const normalizeHost = (value) => value.trim().toLowerCase().replace(/\.$/, '');

const hostProblem = (host) => {
  if (!host) return 'Enter a host, eq.: myapp.local';
  if (host.length > 253) return 'The host is longer than 253 characters';
  const labels = host.split('.');
  if (!labels.every((label) => hostLabel.test(label))) {
    return 'Use letters, digits, hyphens and dots, eq.: myapp.local';
  }
  if (/^\d+$/.test(labels[labels.length - 1]))
    return 'Use a hostname, not an IP address';
  if (host === 'localhost') return "localhost can't be proxied";
  if (host === state?.adminHost) return `${host} is reserved for this page`;
  return null;
};

const portProblem = (value) => {
  const text = String(value).trim();
  const port = Number(text);
  if (!/^\d{1,5}$/.test(text) || port < 1 || port > 65535)
    return 'Use a port from 1 to 65535';
  if (port === 80 || port === 443)
    return `Port ${port} is used by front-proxy itself`;
  return null;
};

const api = async (method, path, body) => {
  const options = { method, headers: { 'X-Front-Proxy-Token': token } };

  if (method !== 'GET') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body ?? {});
  }

  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
};

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(
    ...children.filter((child) => child !== null && child !== undefined),
  );
  return node;
};

// A button (or link, with `tag`) with an icon before its label.
const withIcon = (name, label, props = {}, tag = 'button') =>
  el(
    tag,
    { ...(tag === 'button' ? { type: 'button' } : {}), ...props },
    icon(name),
    el('span', { textContent: label }),
  );

const chip = (name, label, className) =>
  el('span', { className: `chip ${className}` }, icon(name), label);

let state = null;
let ports = {};
let editing = null;
let messageTimer = null;

// Success messages hide after 5s, unless `sticky`. `tip` adds a second line with an info icon.
const showMessage = (
  text,
  { error = false, sticky = false, tip = null } = {},
) => {
  const message = $('#message');
  const body = el('div', {}, el('span', { textContent: text }));
  if (tip)
    body.append(
      el(
        'small',
        { className: 'message-tip' },
        icon('info'),
        el('span', { textContent: tip }),
      ),
    );
  message.replaceChildren(icon(error ? 'alert' : 'success'), body);
  message.className = error ? 'error' : '';
  message.hidden = false;
  clearTimeout(messageTimer);
  if (!error && !sticky) {
    messageTimer = setTimeout(() => {
      message.hidden = true;
    }, 5000);
  }
};

// Chrome keeps showing "Not secure" for a domain whose cert error it saw before (or clicked
// through) until it's fully restarted, even once the proxy serves a trusted mkcert cert.
const browserRestartTip =
  'If the browser still says "Not secure" for a domain, fully quit it and open it again (on macOS, Cmd+Q, not just closing the window).';

// A hint icon with a Pico tooltip, also readable by screen readers and keyboard focus.
const hint = (text) => {
  const node = el(
    'span',
    { className: 'hint', tabIndex: 0, ariaLabel: text },
    icon('info'),
  );
  node.dataset.tooltip = text;
  return node;
};

// Rows for every host in the config or active in the proxy, with what changed.
const hostRows = () => {
  const names = [
    ...new Set([...Object.keys(state.config), ...Object.keys(state.active)]),
  ].sort();

  return names.map((host) => {
    const config = state.config[host];
    const active = state.active[host];
    let change = null;

    if (!active) change = 'added';
    else if (!config) change = 'removed';
    else if (config.port !== active.port || config.cert !== active.cert)
      change = 'changed';

    return { host, config, active, change, entry: config ?? active };
  });
};

const copyLink = (text, label) => {
  const link = withIcon(
    'copy',
    label,
    { href: '#', className: 'copy-link', title: text },
    'a',
  );
  const setLabel = (name, value) =>
    link.replaceChildren(icon(name), el('span', { textContent: value }));
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(text);
      setLabel('check', 'Copied');
      setTimeout(() => setLabel('copy', label), 1500);
    } catch {
      showMessage(`Copy this command: ${text}`);
    }
  });
  return link;
};

const certCell = (host, { cert, certStatus }) => {
  const command = `front-proxy generate-certs ${host}`;

  if (certStatus === 'own') {
    return el(
      'td',
      {},
      el(
        'span',
        { className: 'with-hint' },
        chip('shieldCheck', cert === host ? 'Own cert' : `Cert: ${cert}`, 'on'),
        hint('Browser says "Not secure"? Quit and reopen your browser.'),
      ),
    );
  }

  const missing = certStatus === 'missing';
  const label = missing
    ? chip('shieldAlert', `Cert "${cert}" not found`, 'pending')
    : chip('shield', 'Default cert', 'off');
  const note = el(
    'div',
    { className: 'cert-note', role: 'note' },
    icon('alert'),
    el(
      'div',
      {},
      el('p', {
        textContent: `${
          missing
            ? "Its cert files weren't found, so HTTPS won't work for this domain."
            : "HTTPS won't work for this domain until it has its own cert."
        } Run this command in a terminal, then click Apply now.`,
      }),
      copyLink(command, 'Copy command'),
    ),
  );

  return el('td', {}, el('div', { className: 'cert-cell' }, label, note));
};

const portCell = ({ host, config, active, change }) => {
  if (editing === host) {
    const input = el('input', {
      type: 'number',
      min: 1,
      max: 65535,
      value: config.port,
      ariaLabel: `Port for ${host}`,
    });
    const save = withIcon('check', 'Save', { type: 'submit' });
    const cancel = withIcon('x', 'Cancel', { className: 'secondary outline' });
    const form = el(
      'form',
      { className: 'port-edit', noValidate: true },
      input,
      save,
      cancel,
    );

    cancel.addEventListener('click', () => {
      editing = null;
      render();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const problem = portProblem(input.value);
      if (problem) return showMessage(problem, { error: true });
      try {
        state = await api('PUT', `/api/hosts/${encodeURIComponent(host)}`, {
          port: Number(input.value),
        });
        editing = null;
        render();
        showMessage(`${host} now points to port ${input.value}.`);
      } catch (err) {
        showMessage(err.message, { error: true });
      }
    });
    queueMicrotask(() => input.focus());

    return el('td', {}, form);
  }

  const cell = el('td');
  if (change === 'changed' && active.port !== config.port) {
    cell.append(
      el('span', { className: 'old-port', textContent: `:${active.port}` }),
    );
  }
  cell.append(`:${(config ?? active).port}`);
  return cell;
};

const openLink = (protocol, host) =>
  withIcon(
    'external',
    protocol.toUpperCase(),
    {
      href: `${protocol}://${host}`,
      target: '_blank',
      rel: 'noopener noreferrer',
    },
    'a',
  );

// Why HTTPS can't be opened for an active host, or null when it can. Without its own cert
// the proxy serves the default one (localhost), which browsers reject for this domain.
const httpsProblem = ({ config, active }) => {
  if (!state.https) return 'HTTPS is off: generate certs and restart';
  if (active.certStatus === 'own') return null;
  if (config?.certStatus === 'own') return 'New cert saved: click Apply now';
  return 'Needs its own cert (see Certificate)';
};

const linksCell = (row) => {
  if (!row.active) return el('td', { className: 'muted', textContent: '—' });

  const links = el(
    'td',
    {},
    el('div', { className: 'links' }, openLink('http', row.host)),
  );
  const problem = httpsProblem(row);

  if (!problem) {
    links.firstChild.append(openLink('https', row.host));
    return links;
  }

  const disabled = el(
    'span',
    { className: 'link-disabled' },
    icon('external'),
    el('span', { textContent: 'HTTPS' }),
  );
  disabled.setAttribute('aria-disabled', 'true');

  links.firstChild.append(
    el('span', { className: 'with-hint' }, disabled, hint(problem)),
  );
  return links;
};

const actionsCell = (row) => {
  const cell = el('td');
  const actions = el('div', { className: 'cell-actions' });

  if (row.config) {
    const edit = withIcon('pencil', 'Edit port', {
      className: 'secondary outline',
    });
    const remove = withIcon('trash', 'Remove', { className: 'secondary' });
    edit.addEventListener('click', () => {
      editing = row.host;
      render();
    });
    remove.addEventListener('click', () => confirmRemove(row.host));
    actions.append(edit, remove);
  }

  cell.append(actions);
  return cell;
};

const changeLabels = {
  added: 'Pending add',
  removed: 'Pending removal',
  changed: 'Pending change',
};

const render = () => {
  if (!state) return;

  const https = $('#https-status');
  https.replaceChildren(
    icon(state.https ? 'lock' : 'lockOpen'),
    state.https ? 'HTTPS :443' : 'HTTPS off',
  );
  https.className = state.https ? 'chip on' : 'chip off';
  https.title = state.https
    ? ''
    : 'Run front-proxy generate-certs, then restart front-proxy';
  $('#http-status').className = 'chip on';

  $('#pending').hidden = !state.pending;

  const rows = hostRows();
  const tbody = $('#hosts');
  tbody.replaceChildren(
    ...rows.map((row) => {
      const status = ports[row.host];
      const dot = el('span', {
        className: `dot ${status ?? ''}`,
        title:
          status === 'up'
            ? `Something is listening on port ${row.entry.port}`
            : status === 'down'
              ? `Nothing is listening on port ${row.entry.port}`
              : 'Checking…',
      });
      dot.dataset.host = row.host;

      const hostCell = el(
        'td',
        {},
        el('span', { className: 'host-name', textContent: row.host }),
      );
      if (row.change)
        hostCell.append(
          el('span', {
            className: 'chip pending',
            textContent: changeLabels[row.change],
          }),
        );

      return el(
        'tr',
        { className: row.change === 'removed' ? 'removed' : '' },
        el('td', {}, dot),
        hostCell,
        portCell(row),
        row.config
          ? certCell(row.host, row.config)
          : el('td', { className: 'muted', textContent: '—' }),
        linksCell(row),
        actionsCell(row),
      );
    }),
  );

  $('#empty').hidden = rows.length > 0;
};

const updateDots = () => {
  document.querySelectorAll('.dot[data-host]').forEach((dot) => {
    const status = ports[dot.dataset.host];
    dot.className = `dot ${status ?? ''}`;
  });
};

// Re-renders only when something changed, so polling doesn't reset hovers or "Copied" labels.
const loadState = async () => {
  try {
    const next = await api('GET', '/api/state');
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    if (editing && !state.config[editing]) editing = null;
    if (changed) render();
  } catch (err) {
    showMessage(
      `Couldn't load the hosts: ${err.message}. Is front-proxy running?`,
      { error: true },
    );
  }
};

const loadPorts = async () => {
  try {
    ports = await api('GET', '/api/status');
    updateDots();
  } catch {
    // The next poll tries again.
  }
};

const confirmRemove = (host) => {
  const dialog = $('#confirm-remove');
  $('#confirm-host').textContent = host;
  dialog.dataset.host = host;
  dialog.showModal();
};

$('#confirm-remove').addEventListener('click', (event) => {
  if (
    event.target.matches('[data-close]') ||
    event.target === event.currentTarget
  ) {
    event.currentTarget.close();
  }
});

$('#confirm-remove-button').addEventListener('click', async () => {
  const dialog = $('#confirm-remove');
  const { host } = dialog.dataset;
  dialog.close();
  try {
    state = await api('DELETE', `/api/hosts/${encodeURIComponent(host)}`);
    render();
    showMessage(`${host} removed from the config.`);
  } catch (err) {
    showMessage(err.message, { error: true });
  }
});

$('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const host = normalizeHost(form.host.value);
  const problem = hostProblem(host) || portProblem(form.port.value);
  const errorLine = $('#add-error');

  if (problem) {
    errorLine.textContent = problem;
    errorLine.hidden = false;
    return;
  }

  errorLine.hidden = true;
  try {
    state = await api('POST', '/api/hosts', {
      host,
      port: Number(form.port.value),
    });
    form.reset();
    render();
    loadPorts();
    showMessage(
      `${host} added. Apply the changes or restart front-proxy to use it.`,
    );
  } catch (err) {
    errorLine.textContent = err.message;
    errorLine.hidden = false;
  }
});

$('#apply').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  try {
    const before = state;
    const result = await api('POST', '/api/apply');
    // Hosts whose own cert the proxy serves now, but didn't before applying.
    const newCerts = Object.keys(result.active).filter(
      (host) =>
        result.active[host].certStatus === 'own' &&
        before?.active[host]?.certStatus !== 'own',
    );
    state = result;
    render();

    if (result.httpsNeedsRestart) {
      showMessage('Changes applied. Restart front-proxy to turn HTTPS on.');
    } else if (newCerts.length && state.https) {
      showMessage(
        `Changes applied. HTTPS now uses the new cert for ${newCerts.join(', ')}.`,
        { sticky: true, tip: browserRestartTip },
      );
    } else {
      showMessage(
        'Changes applied. /etc/hosts and the proxy routes are up to date.',
      );
    }
  } catch (err) {
    showMessage(err.message, { error: true });
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
});

// Picks up changes made with the CLI (add, remove, generate-certs) while the page is open.
const refresh = () => {
  if (document.hidden) return;
  if (!editing) loadState();
  loadPorts();
};

document.addEventListener('visibilitychange', refresh);
window.addEventListener('focus', refresh);
setInterval(refresh, 5000);

hydrateIcons();
loadState().then(loadPorts);
