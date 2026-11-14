import { NextResponse } from 'next/server';

export function badRequest(message) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function serverError(err) {
  console.error(err);
  const message = err?.message || 'Something went wrong.';
  return NextResponse.json({ error: message }, { status: err?.status && err.status < 500 ? err.status : 500 });
}
