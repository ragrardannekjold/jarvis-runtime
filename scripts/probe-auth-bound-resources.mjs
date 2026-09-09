const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'jarvis-auth-bound-probe', version: '0.1.0' },
  },
});

async function probeMcp(id, url) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'Jarvis-Investigation-Connector-Probe/0.1',
    },
    body: initBody,
  });
  const result = {
    id,
    url,
    http_status: response.status,
    location: response.headers.get('location'),
    www_authenticate: response.headers.get('www-authenticate'),
    classification:
      response.status >= 200 && response.status < 300
        ? 'ANONYMOUS_REQUEST_ACCEPTED'
        : [301, 302, 303, 307, 308, 401, 403].includes(response.status)
          ? 'OWNER_AUTHORIZATION_REQUIRED_OR_REDIRECTED'
          : 'NON_SUCCESS_REQUIRES_PROVIDER_REVIEW',
  };
  console.log(JSON.stringify(result));
  return result;
}

async function probeHibp() {
  const response = await fetch(
    'https://haveibeenpwned.com/api/v3/breachedaccount/nobody%40example.invalid?truncateResponse=true',
    {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': 'Jarvis-Investigation-Connector-Probe/0.1' },
    },
  );
  const result = {
    id: 'haveibeenpwned_account_lookup',
    url: 'https://haveibeenpwned.com/api/v3/breachedaccount/{account}',
    http_status: response.status,
    www_authenticate: response.headers.get('www-authenticate'),
    classification:
      [401, 402, 403].includes(response.status)
        ? 'API_KEY_REQUIRED'
        : response.status >= 200 && response.status < 300
          ? 'ANONYMOUS_REQUEST_ACCEPTED'
          : 'NON_SUCCESS_REQUIRES_PROVIDER_REVIEW',
  };
  console.log(JSON.stringify(result));
  return result;
}

const results = [];
results.push(await probeMcp('alphaxiv', 'https://api.alphaxiv.org/mcp/v1'));
results.push(await probeMcp('grain', 'https://api.grain.com/_/mcp'));
results.push(await probeHibp());

if (results.some((x) => x.classification === 'ANONYMOUS_REQUEST_ACCEPTED')) {
  console.log(JSON.stringify({
    status: 'AUTH_PROBE_FOUND_ANONYMOUS_PATH_REVIEW_REQUIRED',
    results,
  }));
} else {
  console.log(JSON.stringify({
    status: 'AUTH_BOUND_RESOURCES_CONFIRMED',
    results,
  }));
}
