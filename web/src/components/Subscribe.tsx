import { useState, type FormEvent } from 'react';

type State = { kind: 'idle' | 'sending' | 'ok' | 'err'; text: string };

export default function Subscribe() {
  const [state, setState] = useState<State>({ kind: 'idle', text: '' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setState({ kind: 'sending', text: 'Mengirim…' });
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.get('name'), whatsapp: data.get('whatsapp') }),
      });
      const body = (await res.json()) as { message: string };
      if (!res.ok) throw new Error(body.message);
      setState({ kind: 'ok', text: body.message });
      form.reset();
    } catch (err) {
      setState({
        kind: 'err',
        text: err instanceof Error && err.message ? err.message : 'Server belum bisa dihubungi, coba lagi nanti.',
      });
    }
  }

  return (
    <form className="form" method="post" onSubmit={onSubmit} noValidate>
      <label>
        Nama
        <input name="name" type="text" autoComplete="name" maxLength={60} required placeholder="Contoh: Bu Rani" />
      </label>
      <label>
        Nomor WhatsApp
        <input name="whatsapp" type="tel" inputMode="tel" autoComplete="tel" required placeholder="0812 3456 7890" />
      </label>
      <button className="btn" type="submit" disabled={state.kind === 'sending'}>
        Kirim promo ke WhatsApp saya
      </button>
      <p className={`msg ${state.kind === 'ok' ? 'ok' : state.kind === 'err' ? 'err' : ''}`} role="status">
        {state.text}
      </p>
    </form>
  );
}
