// One setup for the interface (docs/design/setup.md §1): "This computer"
// (`controller.ts`) and "Another computer" (`remote.ts`) behind the one
// `SetupHost` the bridge calls, sharing one setup slice. The route part of
// the slice, which the status strip and Settings read, is the SSH route's and
// outlives every setup screen.

import {
  initialSetupState,
  type ApprovalPlace,
  type ClawtrateClient,
  type RouteStatus,
  type SetupHost,
  type SetupState,
} from "@clawtrate/core";

import type { SetupController } from "./controller.ts";
import type { RemoteSetup } from "./remote.ts";

/** The setup slice, published whole: the screens' part and the route's. */
export class SetupSlice {
  private main: SetupState = initialSetupState;
  private route: RouteStatus | null = null;
  private readonly client: ClawtrateClient;

  constructor(client: ClawtrateClient) {
    this.client = client;
  }

  setMain(next: SetupState): void {
    this.main = next;
    this.push();
  }

  setRoute(route: RouteStatus | null): void {
    this.route = route;
    this.push();
  }

  private push(): void {
    this.client.setSetup({ ...this.main, route: this.route });
  }
}

export class SetupRouter implements SetupHost {
  private readonly here: SetupController;
  private readonly remote: RemoteSetup | null;
  /** Each request that moves setup (a Look here or there, Back, reset), numbered as it comes. */
  private request = 0;

  constructor(here: SetupController, remote: RemoteSetup | null) {
    this.here = here;
    this.remote = remote;
  }

  /** Where the owner approves a request for the gateway at `url`, for the approve command (§9). */
  placeFor(url: string): ApprovalPlace | null {
    return this.remote?.placeFor(url) ?? this.here.placeFor(url);
  }

  async look(): Promise<void> {
    this.request += 1;
    this.remote?.reset();
    await this.here.look();
  }

  cancel(): void {
    this.request += 1;
    if (this.remote?.active) this.remote.cancel();
    else this.here.cancel();
  }

  async connect(): Promise<void> {
    if (this.remote?.active) return this.remote.connect();
    return this.here.connect();
  }

  reset(): void {
    this.request += 1;
    void this.here.reset();
    this.remote?.reset();
  }

  async there(destination: string): Promise<void> {
    if (!this.remote) throw new Error("This host doesn't reach another computer over SSH.");
    // This computer's cleanup finishes first: a failure of it is said while its screens are the
    // ones shown, never over another computer's that share the slice. A request that came while
    // it finished (Back, a reset, a Look here or another there) is the one that counts then.
    const mine = (this.request += 1);
    await this.here.reset();
    if (mine !== this.request) return;
    await this.remote.there(destination);
  }

  async trustKey(): Promise<void> {
    await this.need().trustKey();
  }

  async replaceKey(): Promise<void> {
    await this.need().replaceKey();
  }

  async start(): Promise<void> {
    await this.need().start();
  }

  async retryRoute(): Promise<void> {
    this.request += 1;
    await this.need().retryRoute();
  }

  async removeRoute(): Promise<void> {
    await this.need().removeRoute();
  }

  private need(): RemoteSetup {
    if (!this.remote) throw new Error("This host doesn't reach another computer over SSH.");
    return this.remote;
  }
}
