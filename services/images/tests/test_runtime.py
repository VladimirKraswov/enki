import unittest
import numpy as np
from PIL import Image
from runtime import resolve_profile, render_size, output_image

class Profiles(unittest.TestCase):
    def test_auto_uses_verified_quality_instead_of_unverified_style_model_or_draft(self):
        self.assertEqual(resolve_profile('enki-image-auto', 'beautiful anime portrait'), 'sdxl-lightning')
        self.assertEqual(resolve_profile('enki-image-auto', 'Портрет в стиле аниме'), 'sdxl-lightning')
        self.assertEqual(resolve_profile('enki-image-auto', 'granite anime texture', True), 'sdxl-lightning')
        self.assertEqual(resolve_profile('enki-image-auto', 'watercolor boat'), 'sdxl-lightning')
        self.assertEqual(resolve_profile('lcm-dreamshaper-v7', 'anime'), 'lcm-dreamshaper-v7')
        with self.assertRaises(ValueError): resolve_profile('missing', 'a')
        with self.assertRaises(ValueError): resolve_profile('animagine-lightning','anime')
    def test_auto_routes_existing_image_edits_to_instruction_klein_and_preserves_explicit_legacy(self):
        self.assertEqual(resolve_profile('enki-image-auto','change hair',editing=True),'flux-klein-4b')
        self.assertEqual(resolve_profile('enki-image-auto','stone',material=True),'sdxl-lightning')
        self.assertEqual(resolve_profile('sdxl-lightning','change hair',editing=True),'sdxl-lightning')
        self.assertEqual(resolve_profile('flux-klein-4b','change hair',editing=True),'flux-klein-4b')
        with self.assertRaisesRegex(ValueError,'LCM'):resolve_profile('lcm-dreamshaper-v7','edit',editing=True)
        with self.assertRaisesRegex(ValueError,'source_image'):resolve_profile('flux-klein-4b','new picture')
        self.assertEqual(render_size(512,512,'flux-klein-4b'),(512,512))
        self.assertEqual(render_size(512,768,'flux-klein-4b'),(512,768))
    def test_sdxl_does_not_render_a_512px_face_at_low_native_resolution(self):
        self.assertEqual(render_size(512, 512, 'sdxl-lightning'), (1024, 1024))
        self.assertEqual(render_size(512, 512, 'lcm-dreamshaper-v7'), (512, 512))
        w, h = render_size(512, 768, 'sdxl-lightning')
        self.assertLess(abs(w / h - 2 / 3), .05)
        self.assertEqual(render_size(256,1536,'sdxl-lightning'),(256,1536))
    def test_periodic_downsample_reads_neighbors_and_preserves_requested_size(self):
        a = np.random.default_rng(42).integers(0, 255, (128, 128, 3), np.uint8)
        image = Image.fromarray(a)
        result = np.asarray(output_image(image, (64, 64), True))
        shifted = output_image(Image.fromarray(np.roll(a, (16, 24), (0, 1))), (64, 64), True)
        np.testing.assert_array_equal(np.asarray(shifted), np.roll(result, (8, 12), (0, 1)))
