import unittest

from build_airac_boundaries import BoundaryGraph, hong_kong_edges


class BoundaryConnectionsTest(unittest.TestCase):
    def test_projection_uses_source_path_and_preserves_xml_endpoints(self):
        graph = BoundaryGraph([((0, 0), (0, 1)), ((0, 1), (1, 1)), ((1, 1), (1, 0))])
        start, end = (0.001, 0.2), (0.999, 0.3)
        path, offsets, length = graph.route(start, end)
        self.assertEqual(path[0], start)
        self.assertEqual(path[-1], end)
        self.assertIn((0, 1), path)
        self.assertIn((1, 1), path)
        self.assertTrue(all(100 < value < 120 for value in offsets))
        self.assertGreater(length, 200000)
        reverse, _, _ = graph.route(end, start)
        self.assertEqual(reverse, list(reversed(path)))

    def test_same_edge_route_does_not_detour_to_source_vertices(self):
        graph = BoundaryGraph([((0, 0), (1, 0))])
        path, offsets, length = graph.route((0.2, 0), (0.3, 0))
        self.assertEqual(path, [(0.2, 0), (0.3, 0)])
        self.assertEqual(offsets, [0, 0])
        self.assertLess(length, 12000)

    def test_disconnected_and_distant_endpoints_are_not_bridged(self):
        graph = BoundaryGraph([((0, 0), (0, 1)), ((1, 0), (1, 1))])
        with self.assertRaisesRegex(ValueError, '路径不连通'):
            graph.route((0, 0.2), (1, 0.2))
        with self.assertRaisesRegex(ValueError, '端点距参考边界过远'):
            graph.route((20, 20), (1, 0.2))

    def test_shared_district_lines_are_removed_before_routing(self):
        data = {'features': [
            {'geometry': {'type': 'Polygon', 'coordinates': [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}},
            {'geometry': {'type': 'Polygon', 'coordinates': [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]}},
        ]}
        edges = hong_kong_edges(data)
        self.assertNotIn(((1, 0), (1, 1)), edges)
        graph = BoundaryGraph(edges)
        path, _, length = graph.route((1, 0), (1, 1))
        self.assertGreater(length, 300000)
        self.assertTrue(any(p[0] in [0, 2] for p in path))


if __name__ == '__main__':
    unittest.main()
