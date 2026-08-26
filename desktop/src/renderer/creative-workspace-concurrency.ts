export type RequestToken = Readonly<{
  generation: number;
  scope: string;
}>;

export class LatestRequestGate {
  private generation = 0;

  begin(scope: string): RequestToken {
    this.generation += 1;
    return { generation: this.generation, scope };
  }

  invalidate(): void {
    this.generation += 1;
  }

  accepts(token: RequestToken, scope: string): boolean {
    return token.generation === this.generation && token.scope === scope;
  }
}

export class SerializedMutationGate {
  private generation = 0;
  private active: RequestToken | null = null;

  begin(scope: string): RequestToken | null {
    if (this.active) return null;
    this.generation += 1;
    this.active = { generation: this.generation, scope };
    return this.active;
  }

  accepts(token: RequestToken, scope: string): boolean {
    return this.active === token && token.scope === scope;
  }

  finish(token: RequestToken): boolean {
    if (this.active !== token) return false;
    this.active = null;
    return true;
  }

  invalidate(): void {
    this.generation += 1;
    this.active = null;
  }
}
