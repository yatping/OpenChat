// Stands in for a relay in S6. Also serves a well-known document, as an installation would.
export default {
  fetch(request: Request) {
    return Response.json({ peer: 'ok', path: new URL(request.url).pathname });
  },
};
