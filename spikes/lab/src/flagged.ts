// S6 with the compatibility flag that lets a Worker fetch another on the same zone.
export default {
  async fetch(request: Request) {
    const target = new URL(request.url).searchParams.get('url') ?? '';
    if (!/^https:\/\/openchat-spike-[a-z]+\./.test(target)) return new Response('Not a spike target', { status: 400 });
    const response = await fetch(target);
    return Response.json({ status: response.status, body: (await response.text()).slice(0, 120) });
  },
};
