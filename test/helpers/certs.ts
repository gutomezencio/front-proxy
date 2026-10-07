import { execFileSync } from 'child_process'
import { join } from 'path'

// Writes a throwaway self-signed cert where Server.readCert(name) looks for it.
export const writeCert = (keysPath, name, commonName = name) => {
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=${commonName}`,
      '-keyout', join(keysPath, `_private-${name}-key.pem`),
      '-out', join(keysPath, `_private-${name}-cert.pem`),
    ],
    { stdio: 'ignore' },
  )
}
