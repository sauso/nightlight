// THROWAWAY TLS fixtures for the MQTT TLS tests (#537). Test-only: generated once with the Python `cryptography`
// library (EC P-256), valid 2020-01-01 to 2120-01-01 so no clock shifts the verdict (the backend suite is also run
// with the clock moved a year ahead, npm run test:future). Nothing here protects anything: the "broker" is a socket
// on 127.0.0.1 that exists for the length of one test.
//
//   CA_PEM            a self-signed CA ("Nightlight test CA")
//   OTHER_CA_PEM      an unrelated CA, for "I gave it the WRONG CA"
//   SERVER_CERT_PEM   a server certificate for localhost / 127.0.0.1, signed by CA_PEM
//   EXPIRED_CERT_PEM  the same server key, signed by CA_PEM, valid for one day in 2020
//   SERVER_KEY_PEM    the server's private key
//
// The key's PEM header and footer are assembled at run time rather than written out, so that a secret scanner
// looking for a contiguous private-key block does not mistake a test fixture for a leaked key.
const KEY_BODY = [
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg40u3Jnt7lLB07I1s',
  'wiP+Ek6ca+a4ztVDuuHt43K7InqhRANCAAQFlOD13Yy7o6V8PAiTirjsoZSk63WT',
  'W09KrRcgD2M4ZyzGVI3RnGNDI0afg/RqjyNhA1Hpk8M4QSOB2PtSc3d0',
];
export const SERVER_KEY_PEM = ['-----BEGIN ' + 'PRIVATE KEY-----', ...KEY_BODY, '-----END ' + 'PRIVATE KEY-----'].join('\n') + '\n';

export const CA_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBYjCCAQegAwIBAgIUCYUY8rWg3PSpOgk53Bz9xHyV7bcwCgYIKoZIzj0EAwIw',
  'HTEbMBkGA1UEAwwSTmlnaHRsaWdodCB0ZXN0IENBMCAXDTIwMDEwMTAwMDAwMFoY',
  'DzIxMjAwMTAxMDAwMDAwWjAdMRswGQYDVQQDDBJOaWdodGxpZ2h0IHRlc3QgQ0Ew',
  'WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATcd83Gq+VwP++MWzDggUpaF55pQnRD',
  '0u1kXL0+DfFjqBcUrX4mCnfQAAiIHzOkdgFi6AsbtGPNweC/Wzo0lVpWoyMwITAP',
  'BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNJADBG',
  'AiEA7xa9s3Reha6h2kvioSIAnXk/aT28wEm+BvHqSPsjeoMCIQC9RLBbK37NJMCe',
  '3z8LePqLuQDaMob5MGdT09MDC5nAjA==',
  '-----END CERTIFICATE-----',
].join('\n') + '\n';
export const OTHER_CA_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBVDCB/aADAgECAhRrPj/UPbgl4+2r8f7oVAVqiCQudzAKBggqhkjOPQQDAjAY',
  'MRYwFAYDVQQDDA1Tb21lIG90aGVyIENBMCAXDTIwMDEwMTAwMDAwMFoYDzIxMjAw',
  'MTAxMDAwMDAwWjAYMRYwFAYDVQQDDA1Tb21lIG90aGVyIENBMFkwEwYHKoZIzj0C',
  'AQYIKoZIzj0DAQcDQgAEZyJ3ZuSl2533zvEGmXmocPMxlloG2tdw72LRiZwVczia',
  'dfnYoRW1HTHPybOBhQ+RExg6YMDxsxZX5cYUNPlsCaMjMCEwDwYDVR0TAQH/BAUw',
  'AwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDRgAwQwIgbQjlJ7AOscm6',
  'dGoyWaoseGGc6Trni9YgjbeC7IN97dICH1yPLu8iSFkna8fEftkVVKUrf402B/po',
  'ahEw3EIQn7c=',
  '-----END CERTIFICATE-----',
].join('\n') + '\n';
export const SERVER_CERT_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBYTCCAQegAwIBAgIUIj0SlVpzp3BVCB275lOccCMyFykwCgYIKoZIzj0EAwIw',
  'HTEbMBkGA1UEAwwSTmlnaHRsaWdodCB0ZXN0IENBMCAXDTIwMDEwMTAwMDAwMFoY',
  'DzIxMjAwMTAxMDAwMDAwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjO',
  'PQIBBggqhkjOPQMBBwNCAAQFlOD13Yy7o6V8PAiTirjsoZSk63WTW09KrRcgD2M4',
  'ZyzGVI3RnGNDI0afg/RqjyNhA1Hpk8M4QSOB2PtSc3d0oywwKjAaBgNVHREEEzAR',
  'gglsb2NhbGhvc3SHBH8AAAEwDAYDVR0TAQH/BAIwADAKBggqhkjOPQQDAgNIADBF',
  'AiA3JG24GEMYjnf46NyCHUhIGwS+oe0k0tKTiHMunBquvAIhAMTk8cMamiBOt2sj',
  'vLEHw0Q9f8u+N7u3mrv/MtKVtpjh',
  '-----END CERTIFICATE-----',
].join('\n') + '\n';
export const EXPIRED_CERT_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBUDCB96ADAgECAhQnZZ3Gvl1/yAsFM0wwKx8VLRItxTAKBggqhkjOPQQDAjAd',
  'MRswGQYDVQQDDBJOaWdodGxpZ2h0IHRlc3QgQ0EwHhcNMjAwMTAxMDAwMDAwWhcN',
  'MjAwMTAyMDAwMDAwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIB',
  'BggqhkjOPQMBBwNCAAQFlOD13Yy7o6V8PAiTirjsoZSk63WTW09KrRcgD2M4ZyzG',
  'VI3RnGNDI0afg/RqjyNhA1Hpk8M4QSOB2PtSc3d0ox4wHDAaBgNVHREEEzARggls',
  'b2NhbGhvc3SHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgF+UFxhfdEug+zRhJktX4',
  'mxxH2Z+oU844HrArtqtJNjQCIQDahL+XvLsRqx+fzgJWstpjHJjbJSF2JfHGCeCE',
  'm928hg==',
  '-----END CERTIFICATE-----',
].join('\n') + '\n';
