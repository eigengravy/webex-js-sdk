import {registrationKeepaliveTests} from '../test-groups/registration-keepalive';
import {mobiusSocketCloseEventTests} from '../test-groups/mobius-socket-close-events';

// Account role is resolved from testInfo.project.name → USER_SETS.
registrationKeepaliveTests();
mobiusSocketCloseEventTests();
