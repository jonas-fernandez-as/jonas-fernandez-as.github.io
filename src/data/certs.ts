export interface Cert {
  year: string;
  name: string;
  issuer: string;
  verify?: { label: string; url: string };
  status?: { label: string; variant?: 'progress' };
}

export const certs: Cert[] = [
  { year: '2026', name: 'OSCP+', issuer: 'Offensive Security',
    verify: { label: 'verify ↗', url: 'https://www.credential.net/2ab7a94e-e66f-409a-8e56-a38dda843344' } },
  { year: '2026', name: 'OSCP', issuer: 'Offensive Security',
    verify: { label: 'verify ↗', url: 'https://www.credential.net/af565611-8de7-424b-88a3-b6a9eba9f893' } },
  { year: '2025', name: 'eJPTv2', issuer: 'INE / eLearnSecurity',
    verify: { label: 'verify ↗', url: 'https://www.credential.net/601e2c30-69ba-4751-8a72-3d856b036ff0' } },
  { year: '2025', name: 'CRTO', issuer: 'Zero-Point Security',
    verify: { label: 'verify ↗', url: 'https://certs.zeropointsecurity.co.uk/3ffab0b1-c584-421f-aab1-68c8dbe35994' } },
  { year: '2026', name: 'Malware Development in C', issuer: 'Maldev Academy',
    status: { label: 'In progress', variant: 'progress' } },
  { year: '2026', name: 'ASIR', issuer: 'Formación Profesional Oficial',
    status: { label: 'Sep · Remote' } },
  { year: '2023', name: 'Network Technician', issuer: 'Cisco Networking Academy',
    verify: { label: 'view ↗', url: 'https://drive.google.com/file/d/14zQ0bFp9a3IDUmVO-rTc7Za7eKOKL1WN/view' } },
];
