'use strict';
// Requisição HTTP mínima usando só o Node. Fica no processo principal,
// então não tem problema de CORS e dá pra aceitar certificado autoassinado
// (comum em Zabbix/GLPI internos) quando o usuário pedir.

const http = require('node:http');
const https = require('node:https');

function request(url, { method = 'GET', headers = {}, body, insecure = false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`URL inválida: ${url}`));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error(`Protocolo não suportado: ${u.protocol}`));
      return;
    }

    const lib = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const finalHeaders = { Accept: 'application/json', ...headers };
    if (payload !== undefined) {
      finalHeaders['Content-Type'] = 'application/json';
      finalHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(
      u,
      { method, headers: finalHeaders, rejectUnauthorized: !insecure, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = undefined; // não era JSON
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error(`Tempo esgotado (${timeoutMs / 1000}s) falando com ${u.host}`)));
    req.on('error', (err) => {
      if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        reject(new Error(`Certificado não confiável em ${u.host}. Se for um servidor interno, marque "aceitar certificado autoassinado".`));
        return;
      }
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`Conexão recusada em ${u.host}`));
        return;
      }
      if (err.code === 'ENOTFOUND') {
        reject(new Error(`Não encontrei o host ${u.hostname} (DNS/VPN?)`));
        return;
      }
      reject(err);
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

module.exports = { request };
