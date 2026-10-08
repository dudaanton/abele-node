import os
import time
import unittest

getter_calls = 0

class Example:
    @property
    def computed(self):
        global getter_calls
        getter_calls += 1
        return 99

def investigate():
    value = 40
    obj = Example()
    total = value + 2  # BREAKPOINT
    print('RESULT', total, flush=True)
    try:
        raise ValueError('synthetic exception')
    except ValueError:
        print('CAUGHT', flush=True)
    return total

class SyntheticTest(unittest.TestCase):
    def test_result(self):
        self.assertEqual(investigate(), 42)

if os.getenv('PROBE_TEST'):
    unittest.main()
else:
    investigate()
    while True:
        print('HEARTBEAT', flush=True)
        time.sleep(0.1)
