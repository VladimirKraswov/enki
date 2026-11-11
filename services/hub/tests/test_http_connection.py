import unittest
import test_http as http_tests

class ConnectionHeaders(unittest.TestCase):
    setUp = http_tests.HTTP.setUp
    tearDown = http_tests.HTTP.tearDown
    req = http_tests.HTTP.req

    def test_closed_responses_advertise_close_so_clients_do_not_reuse_dead_tls_sockets(self):
        for path,headers,status in [
            ('/api/model-catalog',None,200),
            ('/downloads/latest',None,404),
            ('/api/model-catalog',{'Origin':'https://other.site'},403),
        ]:
            code,returned,_ = self.req(path,headers=headers)
            self.assertEqual(code,status)
            if status >= 400:
                self.assertEqual(returned.get('Connection'),'close')
            else:
                self.assertNotEqual(returned.get('Connection'),'close')
