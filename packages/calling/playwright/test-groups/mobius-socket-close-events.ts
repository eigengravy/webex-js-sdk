import {Browser, BrowserContext, Page, expect, test} from '@playwright/test';
import {getToken, getUserSet, isIntProject, isMobiusWsMode} from '../test-data';
import {REGISTRATION_TIMEOUT, SDK_INIT_TIMEOUT} from '../constants';
import {
  initializeCallingSDK,
  navigateToCallingApp,
  setEnvironmentToInt,
  setServiceIndicator,
  verifyMobiusWebSocketEnabled,
  verifySDKInitialized,
} from '../utils/setup';
import {
  isLineRegistered,
  registerLine,
  unregisterLine,
  verifyLineRegistered,
} from '../utils/registration';
import {MOBIUS_WS_MESSAGE, MobiusWsInterceptor} from '../utils/mobius-ws';

type CloseScenario = {
  code: number;
  reason: string;
  expectedDisconnectReason?: 'permanent' | 'transient';
};

type DisconnectReason = NonNullable<CloseScenario['expectedDisconnectReason']>;

type SetupResult = {
  context: BrowserContext;
  page: Page;
  interceptor: MobiusWsInterceptor;
  closeState: {
    connectionCount: number;
    registerRequestCount: number;
    closeTriggered: boolean;
  };
};

const CLOSE_OBSERVATION_MS = 10000;

const installEventCapture = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const client = (window as any).callingClient;
    const line = Object.values(client.getLines())[0] as any;

    (window as any).__mobiusCloseTestEvents = {
      connected: 0,
      disconnected: [] as Array<{reason?: string}>,
      unregistered: 0,
    };

    client.on('callingClient:mobius_socket_connected', () => {
      (window as any).__mobiusCloseTestEvents.connected += 1;
    });
    client.on('callingClient:mobius_socket_disconnected', (event: {reason?: string}) => {
      (window as any).__mobiusCloseTestEvents.disconnected.push(event);
    });
    line?.on('unregistered', () => {
      (window as any).__mobiusCloseTestEvents.unregistered += 1;
    });
  });

const getCapturedEvents = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).__mobiusCloseTestEvents || {
        connected: 0,
        disconnected: [],
        unregistered: 0,
      }
  );

const resetCapturedEvents = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as any).__mobiusCloseTestEvents = {
      connected: 0,
      disconnected: [] as Array<{reason?: string}>,
      unregistered: 0,
    };
  });

const isMobiusSocketConnected = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as any).callingClient?.apiRequest?.isSocketConnected?.() === true);

const expectDisconnectReason = async (
  page: Page,
  reason: DisconnectReason,
  message: string
): Promise<void> => {
  await expect
    .poll(() => getCapturedEvents(page), {
      message,
      timeout: SDK_INIT_TIMEOUT,
      intervals: [1000],
    })
    .toMatchObject({
      disconnected: expect.arrayContaining([{reason}]),
    });
};

const expectSocketConnected = async (
  page: Page,
  connected: boolean,
  message: string
): Promise<void> => {
  await expect
    .poll(() => isMobiusSocketConnected(page), {
      message,
      timeout: SDK_INIT_TIMEOUT,
      intervals: [1000],
    })
    .toBe(connected);
};

const expectNoReconnect = async (
  page: Page,
  interceptor: MobiusWsInterceptor,
  closeState: SetupResult['closeState']
): Promise<void> => {
  await page.waitForTimeout(CLOSE_OBSERVATION_MS);
  expect(interceptor.getConnectionCount()).toBe(closeState.connectionCount);
  expect(interceptor.getRequestCount(MOBIUS_WS_MESSAGE.REGISTER)).toBe(
    closeState.registerRequestCount
  );
  await expectSocketConnected(page, false, 'Expected Mobius socket to stay disconnected');
};

const expectReconnect = async (
  page: Page,
  interceptor: MobiusWsInterceptor,
  closeState: SetupResult['closeState'],
  message: string
): Promise<void> => {
  await expect
    .poll(() => interceptor.getConnectionCount(), {
      message,
      timeout: SDK_INIT_TIMEOUT,
      intervals: [1000],
    })
    .toBeGreaterThan(closeState.connectionCount);

  await expectSocketConnected(page, true, 'Expected Mobius socket to reconnect');
};

const setupCloseScenario = async (
  browser: Browser,
  projectName: string,
  scenario: CloseScenario
): Promise<SetupResult> => {
  const isInt = isIntProject(projectName);
  const role = getUserSet(projectName).accounts[0];
  let closeTriggered = false;
  const closeState = {
    connectionCount: 0,
    registerRequestCount: 0,
    closeTriggered: false,
  };

  const interceptor = new MobiusWsInterceptor({
    onResponse: (frame, routeContext) => {
      if (frame.subtype === MOBIUS_WS_MESSAGE.REGISTER && frame.statusCode === 200) {
        return {
          ...frame,
          data: {
            ...(frame.data || {}),
            keepaliveInterval: 5,
          },
        };
      }

      if (
        frame.subtype === MOBIUS_WS_MESSAGE.DEVICE_STATUS &&
        frame.statusCode === 200 &&
        !closeTriggered
      ) {
        closeTriggered = true;
        closeState.connectionCount = routeContext.connectionCount;
        closeState.registerRequestCount = interceptor.getRequestCount(MOBIUS_WS_MESSAGE.REGISTER);
        closeState.closeTriggered = true;
        routeContext.closeAfterFrame({
          code: scenario.code,
          reason: scenario.reason,
        });
      }

      return undefined;
    },
  });

  const context = await browser.newContext({ignoreHTTPSErrors: true});
  await interceptor.install(context);

  const page = await context.newPage();

  await navigateToCallingApp(page);
  if (isInt) await setEnvironmentToInt(page);
  await setServiceIndicator(page, 'calling');
  await initializeCallingSDK(page, getToken(role, isInt));
  await verifySDKInitialized(page);
  await verifyMobiusWebSocketEnabled(page);
  await installEventCapture(page);
  await registerLine(page);
  await verifyLineRegistered(page);

  await expect
    .poll(() => closeState.closeTriggered, {
      message: `Expected keepalive to trigger Mobius close code ${scenario.code}`,
      timeout: 30000,
      intervals: [1000],
    })
    .toBe(true);

  return {context, page, interceptor, closeState};
};

const setupIdleCloseScenario = async (
  browser: Browser,
  projectName: string,
  scenario: CloseScenario
): Promise<SetupResult> => {
  const isInt = isIntProject(projectName);
  const role = getUserSet(projectName).accounts[0];
  let closeTriggered = false;
  const closeState = {
    connectionCount: 0,
    registerRequestCount: 0,
    closeTriggered: false,
    armClose: false,
  };

  const interceptor = new MobiusWsInterceptor({
    onResponse: (frame, routeContext) => {
      if (
        closeState.armClose &&
        frame.subtype === MOBIUS_WS_MESSAGE.AUTH &&
        frame.statusCode === 200 &&
        !closeTriggered
      ) {
        closeTriggered = true;
        closeState.connectionCount = routeContext.connectionCount;
        closeState.registerRequestCount = interceptor.getRequestCount(MOBIUS_WS_MESSAGE.REGISTER);
        closeState.closeTriggered = true;
        routeContext.closeAfterFrame({
          code: scenario.code,
          reason: scenario.reason,
        });
      }

      return undefined;
    },
  });

  const context = await browser.newContext({ignoreHTTPSErrors: true});
  await interceptor.install(context);

  const page = await context.newPage();

  await navigateToCallingApp(page);
  if (isInt) await setEnvironmentToInt(page);
  await setServiceIndicator(page, 'calling');
  await initializeCallingSDK(page, getToken(role, isInt));
  await verifySDKInitialized(page);
  await verifyMobiusWebSocketEnabled(page);
  await installEventCapture(page);

  await page.evaluate(async () => {
    const client = (window as any).callingClient;
    const wssUri = client?.primaryWssMobiusUris?.[0] || client?.backupWssMobiusUris?.[0];

    if (!wssUri) {
      throw new Error('No Mobius WSS URI discovered for idle-close test');
    }

    if (client.apiRequest.isSocketConnected?.()) {
      await client.apiRequest.disconnectFromMobiusSocket({
        code: 3050,
        reason: 'done (permanent)',
      });
    }
  });

  await resetCapturedEvents(page);
  closeState.armClose = true;

  await page.evaluate(async () => {
    const client = (window as any).callingClient;
    const wssUri = client?.primaryWssMobiusUris?.[0] || client?.backupWssMobiusUris?.[0];

    await client.apiRequest.connectToMobiusSocket(wssUri.replace(/\/$/, ''));
  });

  await expect
    .poll(() => closeState.closeTriggered, {
      message: `Expected authenticated idle socket to receive close code ${scenario.code}`,
      timeout: 30000,
      intervals: [1000],
    })
    .toBe(true);

  return {context, page, interceptor, closeState};
};

const reconnectSocketForCleanup = async (page: Page): Promise<void> => {
  await page
    .evaluate(async () => {
      const client = (window as any).callingClient;
      const line = Object.values(client.getLines())[0] as any;
      const activeMobiusUrl = line?.registration?.getActiveMobiusUrl?.();

      if (!client?.apiRequest?.isSocketEnabled?.() || !activeMobiusUrl) {
        return;
      }

      if (!client.apiRequest.isSocketConnected?.()) {
        await client.apiRequest.connectToMobiusSocket(activeMobiusUrl.replace(/\/$/, ''));
      }
    })
    .catch(() => {});
};

const cleanupCloseScenario = async (page: Page, context: BrowserContext): Promise<void> => {
  if (!page.isClosed()) {
    await reconnectSocketForCleanup(page);
    await unregisterLine(page).catch(() => {});
  }

  await context.close().catch(() => {});
};

export function mobiusSocketCloseEventTests() {
  test.describe('Mobius Socket Close Events', () => {
    test.skip(!isMobiusWsMode(), 'Mobius socket close-event tests require WSS mode');

    // Message-level 429 handling is intentionally covered by registration/request tests, not
    // this close-event suite.
    const permanentNoReconnectScenarios: CloseScenario[] = [
      {
        code: 1000,
        reason: 'Normal Closure',
        expectedDisconnectReason: 'permanent',
      },
      {
        code: 4429,
        reason: 'Connection Rate Limit',
        expectedDisconnectReason: 'permanent',
      },
    ];

    for (const scenario of permanentNoReconnectScenarios) {
      test(`Mobius close ${scenario.code} does not reconnect`, async ({browser}, testInfo) => {
        test.setTimeout(180000);

        const {context, page, interceptor, closeState} = await setupCloseScenario(
          browser,
          testInfo.project.name,
          scenario
        );

        try {
          await expectDisconnectReason(
            page,
            scenario.expectedDisconnectReason!,
            `Expected permanent disconnect for close ${scenario.code}`
          );
          await expectNoReconnect(page, interceptor, closeState);
        } finally {
          await cleanupCloseScenario(page, context);
        }
      });
    }

    test('Mobius close 1001 on an authenticated socket before registration does not reconnect or register', async ({
      browser,
    }, testInfo) => {
      test.setTimeout(180000);

      const scenario: CloseScenario = {
        code: 1001,
        reason: 'The WebSocket session [1] idle timeout expired',
        expectedDisconnectReason: 'permanent',
      };
      const {context, page, interceptor, closeState} = await setupIdleCloseScenario(
        browser,
        testInfo.project.name,
        scenario
      );

      try {
        await expectDisconnectReason(
          page,
          scenario.expectedDisconnectReason!,
          'Expected permanent disconnect for close 1001'
        );
        await expectNoReconnect(page, interceptor, closeState);
        expect(interceptor.getRequestCount(MOBIUS_WS_MESSAGE.REGISTER)).toBe(0);
        await expect
          .poll(() => isLineRegistered(page), {
            message: 'Expected line to remain unregistered after idle close 1001',
            timeout: REGISTRATION_TIMEOUT,
            intervals: [1000],
          })
          .toBe(false);
      } finally {
        await cleanupCloseScenario(page, context);
      }
    });

    const transientReconnectScenarios: CloseScenario[] = [
      {
        code: 1011,
        reason: 'Server Error',
        expectedDisconnectReason: 'transient',
      },
      {
        code: 1012,
        reason: 'Service restarting, client can re-connect',
        expectedDisconnectReason: 'transient',
      },
    ];

    for (const scenario of transientReconnectScenarios) {
      test(`Mobius close ${scenario.code} reconnects`, async ({browser}, testInfo) => {
        test.setTimeout(180000);

        const {context, page, interceptor, closeState} = await setupCloseScenario(
          browser,
          testInfo.project.name,
          scenario
        );

        try {
          await expectDisconnectReason(
            page,
            scenario.expectedDisconnectReason!,
            `Expected transient disconnect for close ${scenario.code}`
          );
          await expectReconnect(
            page,
            interceptor,
            closeState,
            `Expected reconnect after close ${scenario.code}`
          );

          await expect
            .poll(() => isLineRegistered(page), {
              message: `Expected line to remain registered after close ${scenario.code} reconnect`,
              timeout: REGISTRATION_TIMEOUT,
              intervals: [1000],
            })
            .toBe(true);
        } finally {
          await cleanupCloseScenario(page, context);
        }
      });
    }

    const authReconnectScenarios: CloseScenario[] = [
      {code: 4401, reason: 'Invalid or expired token'},
      {
        code: 4403,
        reason: 'Client failed to send auth message within the configured time limit',
      },
      {code: 4404, reason: 'Session not found, client can re-connect'},
    ];

    for (const scenario of authReconnectScenarios) {
      test(`Mobius close ${scenario.code} reconnects the socket`, async ({browser}, testInfo) => {
        test.setTimeout(180000);

        const {context, page, interceptor, closeState} = await setupCloseScenario(
          browser,
          testInfo.project.name,
          scenario
        );

        try {
          await expectReconnect(
            page,
            interceptor,
            closeState,
            `Expected reconnect after auth/session close ${scenario.code}`
          );

          await expect
            .poll(() => isLineRegistered(page), {
              message: `Expected line to remain registered after auth/session close ${scenario.code}`,
              timeout: REGISTRATION_TIMEOUT,
              intervals: [1000],
            })
            .toBe(true);
        } finally {
          await cleanupCloseScenario(page, context);
        }
      });
    }

    test('Mobius close 4001 triggers registration-down cleanup', async ({browser}, testInfo) => {
      test.setTimeout(180000);

      const scenario: CloseScenario = {
        code: 4001,
        reason: 'Registration no longer active, client can re-register',
        expectedDisconnectReason: 'permanent',
      };
      const {context, page, interceptor, closeState} = await setupCloseScenario(
        browser,
        testInfo.project.name,
        scenario
      );

      try {
        await expectDisconnectReason(
          page,
          'permanent',
          'Expected 4001 to surface registration-down cleanup'
        );

        await expect
          .poll(() => getCapturedEvents(page).then((events) => events.unregistered), {
            message: 'Expected 4001 to emit line unregistered',
            timeout: REGISTRATION_TIMEOUT,
            intervals: [1000],
          })
          .toBeGreaterThan(0);

        await expect
          .poll(() => isLineRegistered(page), {
            message: 'Expected line to become unregistered after 4001',
            timeout: REGISTRATION_TIMEOUT,
            intervals: [1000],
          })
          .toBe(false);

        await expectNoReconnect(page, interceptor, closeState);
      } finally {
        await cleanupCloseScenario(page, context);
      }
    });
  });
}
