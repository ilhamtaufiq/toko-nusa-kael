// Penyimpanan pembayaran di disk. Dipakai agar pembayaran yang belum lunas tidak hilang saat container restart.
// Data: { payments: { [id]: Payment } }. Setiap tulisan memakai file sementara lalu rename, jadi file tidak rusak
// kalau proses berhenti di tengah penulisan.
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';

export class FilePaymentStore {
  constructor(path) {
    this.path = path;
    this.cache = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = { payments: {} };
      return this.cache;
    }
    this.cache = JSON.parse(await readFile(this.path, 'utf8'));
    this.cache.payments ??= {};
    return this.cache;
  }

  // Serialkan semua tulisan agar dua update bersamaan tidak saling menimpa
  save() {
    this.queue = this.queue.then(async () => {
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.cache), { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.queue;
  }

  async create(payment) {
    const data = await this.load();
    data.payments[payment.id] = payment;
    await this.save();
  }

  async update(payment) {
    const data = await this.load();
    data.payments[payment.id] = payment;
    await this.save();
  }

  async get(id) {
    const data = await this.load();
    return data.payments[id];
  }

  async listActive(scope) {
    const data = await this.load();
    return Object.values(data.payments).filter(
      (p) => p.status === 'pending' && (!scope || JSON.stringify(p.scope) === JSON.stringify(scope)),
    );
  }
}
