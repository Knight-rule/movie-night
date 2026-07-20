const fs = require('fs');
const path = require('path');
const os = require('os');

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const lanIp = getLanIp();
const certDir = path.join(__dirname, 'certs');
if (!fs.existsSync(certDir)) fs.mkdirSync(certDir);

const keyPem = path.join(certDir, 'key.pem');
const certPem = path.join(certDir, 'cert.pem');

if (fs.existsSync(keyPem) && fs.existsSync(certPem)) {
  console.log('Certs already exist. LAN IP:', lanIp);
  process.exit(0);
}

const selfsigned = require('selfsigned');
const attrs = [{ name: 'commonName', value: 'MovieNight Dev' }];

(async () => {
  const pems = await selfsigned.generate(attrs, {
    days: 365,
    algorithm: 'sha256',
    extensions: [
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: lanIp },
      ]},
    ],
  });

  fs.writeFileSync(keyPem, pems.private);
  fs.writeFileSync(certPem, pems.cert);
  console.log('HTTPS certs generated!');
  console.log('LAN IP:', lanIp);
  console.log('Access: https://' + lanIp + ':4000');
})();
