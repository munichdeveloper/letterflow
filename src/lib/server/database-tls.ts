import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { getCACertificates } from "node:tls";

// Public root of Supabase's private PKI, not part of Node's Mozilla bundle.
// Source: Dashboard > Database Settings > SSL Configuration (prod-ca-2021.crt).
// SHA-256 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
// Expires 2031-04-26; replace via ACQ_DATABASE_CA_CERT if Supabase rotates it.
export const SUPABASE_ROOT_CA = `
-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;

const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export class DatabaseCaError extends Error {
  code = "DATABASE_CA_INVALID";
}

function trustedCertificates(pem: string) {
  const certificates = pem.match(PEM_CERTIFICATE) ?? [];
  if (!certificates.length)
    throw new DatabaseCaError("Datenbank-CA enthält kein PEM-Zertifikat.");
  for (const certificate of certificates) {
    let parsed: X509Certificate;
    try {
      parsed = new X509Certificate(certificate);
    } catch {
      throw new DatabaseCaError("Datenbank-CA ist nicht lesbar.");
    }
    if (!parsed.ca)
      throw new DatabaseCaError("Datenbank-CA ist kein CA-Zertifikat.");
    if (new Date(parsed.validTo) <= new Date())
      throw new DatabaseCaError("Datenbank-CA ist abgelaufen.");
  }
  return certificates;
}

// The value is inline PEM (escaped \n allowed) or a path to a PEM file.
function readConfiguredCa(value: string) {
  if (value.includes("-----BEGIN")) return value.replaceAll("\\n", "\n");
  try {
    return readFileSync(value, "utf8");
  } catch {
    throw new DatabaseCaError("Datenbank-CA-Datei ist nicht lesbar.");
  }
}

// An object (not a sslmode string) so the URL and PGSSLMODE cannot weaken it.
// `ca` replaces Node's trust store, hence the default certificates are kept.
export function databaseTlsOptions(
  configured = process.env.ACQ_DATABASE_CA_CERT,
) {
  const value = configured?.trim();
  const pem = value ? readConfiguredCa(value) : SUPABASE_ROOT_CA;
  return {
    rejectUnauthorized: true,
    ca: [...getCACertificates("default"), ...trustedCertificates(pem)],
  };
}
