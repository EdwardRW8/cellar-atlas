// @vitest-environment jsdom

/**
 * FIRST-RUN ONBOARDING
 *
 * A signed-in user with no cellar is not an error. These render the REAL
 * `CellarProvider` and the real `useCellar`, mocking only authentication and
 * the repository, so the state machine and the double-click guard are the
 * things actually under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";

// The session object must be STABLE. Returning a fresh object each render
// changes its identity, so useCellar's load effect re-runs forever and the
// provider never settles — which is what made these tests time out.
const signOut = vi.fn();
const SESSION = { session: { user: { id: "user-1" } }, signOut };
vi.mock("@/app/providers/AuthProvider", () => ({ useAuth: () => SESSION }));

const resolveCellar = vi.fn();
const createFirstCellar = vi.fn();
const loadCollection = vi.fn();

vi.mock("@/data/repositories/cellar-repository", () => ({
  CellarRepository: class {
    static resolveCellar = (...a: unknown[]) => resolveCellar(...a);
    static createFirstCellar = (...a: unknown[]) => createFirstCellar(...a);
    loadCollection = (...a: unknown[]) => loadCollection(...a);
    loadCellarProfile = async () => null;
    loadValuationCurrencies = async () => ({
      valuations: new Map(),
      strategy: "none" as const,
    });
    loadAcquisitionCosts = async () => new Map();
    loadGeographyIndex = async () => new Map();
  },
}));
vi.mock("@/data/repositories/mutation-repository", () => ({
  MutationRepository: class {},
}));

const { CellarProvider, useCellar } = await import("@/hooks/useCellar");
const { default: HomeScreen } = await import("@/features/home/index");
const { NoCellarGate, AddWineButton } = await import("@/app/router");
const { default: StorageScreen } = await import("@/features/storage/StorageScreen");

function Probe() {
  const { state, errorKind, creatingCellar } = useCellar();
  return <div data-testid="probe">{`${state}|${errorKind}|${creatingCellar}`}</div>;
}

function CellarIdProbe() {
  const { cellarId } = useCellar();
  return <div data-testid="cellar-id">{cellarId ?? "none"}</div>;
}

const mount = (ui = <HomeScreen />) =>
  render(
    <MemoryRouter>
      <CellarProvider>
        {ui}
        <Probe />
      </CellarProvider>
    </MemoryRouter>,
  );

const probe = () => screen.getByTestId("probe").textContent ?? "";

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: clear keeps implementations, so a
  // rejection set by one test leaked into the next.
  vi.resetAllMocks();
  loadCollection.mockResolvedValue({ wines: [], bottles: [], locations: [] });
  resolveCellar.mockResolvedValue(null);
  createFirstCellar.mockResolvedValue("cellar-1");
});
afterEach(cleanup);

describe("a user with NO memberships sees onboarding, not an error", () => {
  beforeEach(() => resolveCellar.mockResolvedValue(null));

  it("enters the no-cellar state", async () => {
    mount();
    await waitFor(() => expect(probe()).toMatch(/^no-cellar\|/));
  });

  it("offers one clear action and no error wording", async () => {
    mount();
    expect(await screen.findByRole("button", { name: /create my cellar/i })).toBeTruthy();
    expect(screen.queryByText(/could not load your cellar/i)).toBeNull();
  });

  it("never creates a cellar just because the app loaded", async () => {
    mount();
    await waitFor(() => expect(probe()).toMatch(/^no-cellar\|/));
    expect(createFirstCellar).not.toHaveBeenCalled();
  });
});

describe("creating the first cellar", () => {
  beforeEach(() => resolveCellar.mockResolvedValue(null));

  it("A DOUBLE-CLICK creates exactly ONE cellar", async () => {
    // Deliberately slow, so both clicks land before the first resolves.
    let release!: (id: string) => void;
    createFirstCellar.mockImplementation(
      () =>
        new Promise<string>((res) => {
          release = res;
        }),
    );

    mount();
    const button = await screen.findByRole("button", { name: /create my cellar/i });

    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(
      createFirstCellar,
      "the ref guard must absorb the second click",
    ).toHaveBeenCalledTimes(1);
    await act(async () => {
      release("cellar-1");
    });
  });

  it("the button is disabled while the request is in flight", async () => {
    let release!: (id: string) => void;
    createFirstCellar.mockImplementation(
      () =>
        new Promise<string>((res) => {
          release = res;
        }),
    );

    mount();
    const button = await screen.findByRole("button", { name: /create my cellar/i });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(probe()).toBe("no-cellar|unknown|true"));
    expect(
      (screen.getByRole("button", { name: /creating/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      release("cellar-1");
    });
  });

  it("a FAILED creation is visible, not silent", async () => {
    createFirstCellar.mockRejectedValue(new Error("network error: failed to fetch"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /create my cellar/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/failed to fetch/i);
  });

  it("success loads the new cellar", async () => {
    createFirstCellar.mockResolvedValue("cellar-1");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /create my cellar/i }));
    await waitFor(() => expect(probe()).toMatch(/^ready\|/));
  });
});

describe("the three failure states read differently", () => {
  it.each([
    ["permission", "new row violates row-level security policy", /do not have permission/i],
    ["network", "TypeError: Failed to fetch", /could not reach cellar atlas/i],
    ["unknown", "something else entirely", /could not load your cellar/i],
  ])("%s", async (kind, message, heading) => {
    resolveCellar.mockRejectedValue(new Error(message));
    mount();
    await waitFor(() => expect(probe()).toBe(`error|${kind}|false`));
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
  });

  it("no-cellar is NOT one of them", async () => {
    resolveCellar.mockResolvedValue(null);
    mount();
    await waitFor(() => expect(probe()).toMatch(/^no-cellar\|/));
    expect(screen.queryByRole("heading", { name: /could not|permission/i })).toBeNull();
  });
});

describe("REGRESSION: an existing member loads exactly as before", () => {
  it("goes straight to ready and creates nothing", async () => {
    resolveCellar.mockResolvedValue("existing-cellar");
    mount();
    await waitFor(() => expect(probe()).toBe("ready|unknown|false"));
    expect(createFirstCellar).not.toHaveBeenCalled();
    expect(loadCollection).toHaveBeenCalled();
  });

  it("resolveCellar still returns the first membership unchanged", () => {
    // Follow-up 2 (unordered limit(1)) is deliberately NOT changed here.
    const src = readFileSync("src/data/repositories/cellar-repository.ts", "utf8");
    const fn = src.slice(src.indexOf("static async resolveCellar"));
    expect(fn.slice(0, fn.indexOf("\n  }"))).toMatch(/\.limit\(1\)/);
  });
});

describe("the app-level gate blocks every route except Home", () => {
  // Storage, Add Wine, Profile, Import, Tasting Log, History and Geography Fix
  // only branch on `state === "loading"`, so without this gate they rendered
  // as if ready with no cellar behind them. That was the "Storage create does
  // nothing" symptom.
  const at = (path: string, ui: React.ReactNode) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <CellarProvider>
          <NoCellarGate>{ui}</NoCellarGate>
          <Probe />
        </CellarProvider>
      </MemoryRouter>,
    );

  it("/storage shows the notice and NO create control", async () => {
    at("/storage", <StorageScreen />);
    await waitFor(() => expect(probe()).toMatch(/^no-cellar\|/));

    expect(screen.getByText(/create your cellar first/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /add a (storage )?location|create/i }),
      "no create control may be reachable without a cellar",
    ).toBeNull();
  });

  it("Home is exempt — it owns the onboarding", async () => {
    at("/", <HomeScreen />);
    expect(await screen.findByRole("button", { name: /create my cellar/i })).toBeTruthy();
    expect(screen.queryByText(/create your cellar first/i)).toBeNull();
  });

  it("once a cellar exists the route renders normally", async () => {
    resolveCellar.mockResolvedValue("existing-cellar");
    at("/storage", <StorageScreen />);
    await waitFor(() => expect(probe()).toMatch(/^ready\|/));
    expect(screen.queryByText(/create your cellar first/i)).toBeNull();
  });
});

describe("refresh cannot be handed a cellar id", () => {
  it("is a wrapper, so an argument is never forwarded to load()", async () => {
    resolveCellar.mockResolvedValue("existing-cellar");

    let refresh!: (...args: unknown[]) => unknown;
    function Capture() {
      refresh = useCellar().refresh as (...args: unknown[]) => unknown;
      return null;
    }
    render(
      <MemoryRouter>
        <CellarProvider>
          <Capture />
          <Probe />
          <CellarIdProbe />
        </CellarProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(probe()).toMatch(/^ready\|/));
    resolveCellar.mockClear();

    // A click handler would pass an event here; a stray id must not become the
    // cellar that gets loaded.
    await act(async () => {
      await refresh("some-other-cellar-id");
    });

    // The decisive check: the cellar is unchanged. If `refresh` were `load`
    // itself, the argument would have become the cellar id and this would read
    // "some-other-cellar-id".
    expect(screen.getByTestId("cellar-id").textContent).toBe("existing-cellar");
    expect(resolveCellar).not.toHaveBeenCalled();
    expect(probe()).toMatch(/^ready\|/);
  });

  it("takes no parameters at the source", () => {
    const src = readFileSync("src/hooks/useCellar.tsx", "utf8");
    expect(src).toMatch(/refresh: \(\) => load\(\),/);
    expect(src, "passing load directly would forward its first argument").not.toMatch(
      /refresh: load,/,
    );
  });
});

describe("Add Wine is unreachable without a cellar", () => {
  // Add Wine has its own provider and does not render through Root's Outlet,
  // so Root's gate never saw it: the "+" button led to a form with no cellar.
  it('the "+" button is absent in the no-cellar state', async () => {
    render(
      <MemoryRouter>
        <CellarProvider>
          <AddWineButton />
          <Probe />
        </CellarProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(probe()).toMatch(/^no-cellar\|/));
    expect(screen.queryByRole("button", { name: /add wine/i })).toBeNull();
  });

  it("…and returns once a cellar exists", async () => {
    resolveCellar.mockResolvedValue("existing-cellar");
    render(
      <MemoryRouter>
        <CellarProvider>
          <AddWineButton />
          <Probe />
        </CellarProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(probe()).toMatch(/^ready\|/));
    expect(screen.getByRole("button", { name: /add wine/i })).toBeTruthy();
  });

  it("/add shows the notice instead of the form", async () => {
    render(
      <MemoryRouter initialEntries={["/add"]}>
        <CellarProvider>
          <NoCellarGate>
            <div>THE ADD WINE FORM</div>
          </NoCellarGate>
          <Probe />
        </CellarProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(probe()).toMatch(/^no-cellar\|/));
    expect(screen.getByText(/create your cellar first/i)).toBeTruthy();
    expect(screen.queryByText("THE ADD WINE FORM")).toBeNull();
  });
});

describe("a user with no cellar can still sign out", () => {
  // Sign-out lives only on More, which the gate blocks. Without an escape on
  // the onboarding screen a new user would be stuck in the app.
  it("the onboarding screen offers Sign out, and it works", async () => {
    render(
      <MemoryRouter>
        <CellarProvider>
          <HomeScreen />
          <Probe />
        </CellarProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(probe()).toMatch(/^no-cellar\|/));

    const button = screen.getByRole("button", { name: /^sign out$/i });
    fireEvent.click(button);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("More — the usual home of Sign out — is still gated", async () => {
    render(
      <MemoryRouter initialEntries={["/more"]}>
        <CellarProvider>
          <NoCellarGate>
            <div>THE MORE SCREEN</div>
          </NoCellarGate>
          <Probe />
        </CellarProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(probe()).toMatch(/^no-cellar\|/));
    expect(screen.queryByText("THE MORE SCREEN")).toBeNull();
  });
});
