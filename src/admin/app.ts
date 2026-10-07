// front-proxy admin page. Compiled by tsc to a plain ES module, no bundler. The server validates
// everything again; the checks here only give faster feedback. Data is rendered with textContent only.

import { hydrateIcons, icon } from './icons.js';
import {
  hostProblem,
  hostRows,
  httpsProblem,
  newCertHosts,
  normalizeHost,
  portProblem,
  portStatusTitle,
  type DescribedEntry,
  type HostRow,
  type PortStatus,
  type ProxyState,
} from './lib.js';

type State = ProxyState & { httpsNeedsRestart?: boolean };

const token = document.querySelector<HTMLMetaElement>('meta[name="front-proxy-token"]')!.content;

// Every element the page looks up is in index.html.
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const api = async <T = State>(method: string, path: string, body?: unknown): Promise<T> => {
  const headers: Record<string, string> = { 'X-Front-Proxy-Token': token };
  const options: RequestInit = { method, headers };

  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body ?? {});
  }

  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
};

type Child = Node | string | null | undefined;

// `props` are element properties (className, textContent, href…), assigned as is.
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(
    ...children.filter((child): child is Node | string => child !== null && child !== undefined),
  );
  return node;
};

// A button (or link, with `tag`) with an icon before its label.
const withIcon = (
  name: string,
  label: string,
  props: Record<string, unknown> = {},
  tag: 'button' | 'a' = 'button',
) =>
  el(
    // Typed as a button: callers only use what both elements share.
    tag as 'button',
    { ...(tag === 'button' ? { type: 'button' } : {}), ...props },
    icon(name),
    el('span', { textContent: label }),
  );

const chip = (name: string, label: string, className: string) =>
  el('span', { className: `chip ${className}` }, icon(name), label);

let state: State | null = null;
let ports: Record<string, PortStatus> = {};
let editing: string | null = null;
let messageTimer: ReturnType<typeof setTimeout> | undefined;

// Success messages hide after 5s, unless `sticky`. `tip` adds a second line with an info icon.
const showMessage = (
  text: string,
  {
    error = false,
    sticky = false,
    tip = null,
  }: { error?: boolean; sticky?: boolean; tip?: string | null } = {},
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
const hint = (text: string) => {
  const node = el(
    'span',
    { className: 'hint', tabIndex: 0, ariaLabel: text },
    icon('info'),
  );
  node.dataset.tooltip = text;
  return node;
};

const copyLink = (text: string, label: string) => {
  const link = withIcon(
    'copy',
    label,
    { href: '#', className: 'copy-link', title: text },
    'a',
  );
  const setLabel = (name: string, value: string) =>
    link.replaceChildren(icon(name), el('span', { textContent: value }));
  link.addEventListener('click', async (event: Event) => {
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

const certCell = (host: string, { cert, certStatus }: DescribedEntry) => {
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

const portCell = ({ host, config, active, change, entry }: HostRow) => {
  if (editing === host && config) {
    const input = el('input', {
      type: 'number',
      min: '1',
      max: '65535',
      value: String(config.port),
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
    form.addEventListener('submit', async (event: SubmitEvent) => {
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
        showMessage((err as Error).message, { error: true });
      }
    });
    queueMicrotask(() => input.focus());

    return el('td', {}, form);
  }

  const cell = el('td');
  if (change === 'changed' && active && active.port !== entry.port) {
    cell.append(
      el('span', { className: 'old-port', textContent: `:${active.port}` }),
    );
  }
  cell.append(`:${entry.port}`);
  return cell;
};

const openLink = (protocol: string, host: string) =>
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

const linksCell = (row: HostRow) => {
  if (!row.active || !state) return el('td', { className: 'muted', textContent: '—' });

  const linkList = el('div', { className: 'links' }, openLink('http', row.host));
  const links = el('td', {}, linkList);
  const problem = httpsProblem(row, state.https);

  if (!problem) {
    linkList.append(openLink('https', row.host));
    return links;
  }

  const disabled = el(
    'span',
    { className: 'link-disabled' },
    icon('external'),
    el('span', { textContent: 'HTTPS' }),
  );
  disabled.setAttribute('aria-disabled', 'true');

  linkList.append(
    el('span', { className: 'with-hint' }, disabled, hint(problem)),
  );
  return links;
};

const actionsCell = (row: HostRow) => {
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

const changeLabels: Record<string, string> = {
  added: 'Pending add',
  removed: 'Pending removal',
  changed: 'Pending change',
};

const render = (): void => {
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

  const rows = hostRows(state);
  const tbody = $('#hosts');
  tbody.replaceChildren(
    ...rows.map((row) => {
      const status = ports[row.host];
      const dot = el('span', {
        className: `dot ${status ?? ''}`,
        title: portStatusTitle(status, row.entry.port),
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
  document.querySelectorAll<HTMLElement>('.dot[data-host]').forEach((dot) => {
    const status = ports[String(dot.dataset.host)];
    dot.className = `dot ${status ?? ''}`;
  });
};

// Re-renders only when something changed, so polling doesn't reset hovers or "Copied" labels.
const loadState = async () => {
  try {
    const next = await api('GET', '/api/state');
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    if (editing && !next.config[editing]) editing = null;
    if (changed) render();
  } catch (err) {
    showMessage(
      `Couldn't load the hosts: ${(err as Error).message}. Is front-proxy running?`,
      { error: true },
    );
  }
};

const loadPorts = async () => {
  try {
    ports = await api<Record<string, PortStatus>>('GET', '/api/status');
    updateDots();
  } catch {
    // The next poll tries again.
  }
};

const confirmRemove = (host: string) => {
  const dialog = $<HTMLDialogElement>('#confirm-remove');
  $('#confirm-host').textContent = host;
  dialog.dataset.host = host;
  dialog.showModal();
};

$<HTMLDialogElement>('#confirm-remove').addEventListener('click', (event) => {
  const dialog = event.currentTarget as HTMLDialogElement;
  const target = event.target as Element;
  if (target.matches('[data-close]') || target === dialog) {
    dialog.close();
  }
});

$('#confirm-remove-button').addEventListener('click', async () => {
  const dialog = $<HTMLDialogElement>('#confirm-remove');
  const host = String(dialog.dataset.host);
  dialog.close();
  try {
    state = await api('DELETE', `/api/hosts/${encodeURIComponent(host)}`);
    render();
    showMessage(`${host} removed from the config.`);
  } catch (err) {
    showMessage((err as Error).message, { error: true });
  }
});

$('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const fields = form.elements as HTMLFormControlsCollection & {
    host: HTMLInputElement;
    port: HTMLInputElement;
  };
  const host = normalizeHost(fields.host.value);
  const problem =
    hostProblem(host, state?.adminHost) || portProblem(fields.port.value);
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
      port: Number(fields.port.value),
    });
    form.reset();
    render();
    loadPorts();
    showMessage(
      `${host} added. Apply the changes or restart front-proxy to use it.`,
    );
  } catch (err) {
    errorLine.textContent = (err as Error).message;
    errorLine.hidden = false;
  }
});

$('#apply').addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  try {
    const before = state;
    const result = await api('POST', '/api/apply');
    const newCerts = newCertHosts(before, result);
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
    showMessage((err as Error).message, { error: true });
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
