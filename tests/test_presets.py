"""Pure synthetic tests: unified preset data without PSDs, media or disk I/O."""

from dataclasses import FrozenInstanceError, replace
import unicodedata
import unittest

from tachie_motion.presets import (
    AiueoMouth,
    EyeStates,
    LayerState,
    LayerStateSet,
    OpenMouth,
    Preset,
    PresetCollection,
    new_preset,
)


def state(*entries: tuple[tuple[int, ...], bool]) -> LayerStateSet:
    return LayerStateSet(tuple(LayerState(path, on) for path, on in entries))


class PresetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = state(((0,), True), ((1,), False), ((2, 0), True))
        self.normal = new_preset("通常", self.base)

    def test_base_on_off_preserves_tree_index_identity_and_names(self):
        self.assertEqual(self.normal.base.layers[2].path, (2, 0))
        self.assertTrue(self.normal.base.layers[2].visible)
        self.assertFalse(self.normal.base.layers[1].visible)
        self.assertEqual(len(self.normal.id), 32)
        self.assertNotEqual(new_preset("通常", self.base).id, self.normal.id)

    def test_one_preset_supports_both_lip_mappings_and_multiple_eye_layers(self):
        closed = state(((3, 0), True), ((3, 1), False))
        opened = state(((3, 0), False), ((3, 1), True))
        mouth = AiueoMouth(*[closed, opened, closed, opened, closed, opened])
        eyes = EyeStates(
            opened=state(((4, 0), True), ((4, 1), True)),
            closed=state(((4, 0), False), ((4, 1), False)),
        )
        all_in_one = replace(
            self.normal,
            open_mouth=OpenMouth(closed=closed, opened=opened),
            aiueo_mouth=mouth,
            eyes=eyes,
            blink_enabled=True,
        )
        self.assertIsNotNone(all_in_one.open_mouth)
        self.assertIsNotNone(all_in_one.aiueo_mouth)
        self.assertEqual(len(all_in_one.eyes.opened.layers), 2)
        self.assertEqual(all_in_one.aiueo_mouth.n, opened)
        self.assertEqual(all_in_one.base, self.base)

    def test_immutable_nested_values_and_independent_duplicate(self):
        collection = PresetCollection().append(self.normal).duplicate(self.normal.id)
        original, copied = collection.presets
        self.assertEqual(original.name, copied.name)
        self.assertNotEqual(original.id, copied.id)
        with self.assertRaises(FrozenInstanceError):
            original.name = "mutated"
        with self.assertRaises(FrozenInstanceError):
            original.base.layers[0].visible = False
        renamed = collection.rename(copied.id, "にっこり")
        self.assertEqual(renamed.presets[0].name, "通常")
        self.assertEqual(renamed.presets[1].name, "にっこり")
        self.assertEqual(collection.presets[1].name, "通常")
        changed_copy = replace(renamed.presets[1], base=state(((0,), False)))
        self.assertTrue(renamed.presets[0].base.layers[0].visible)
        self.assertFalse(changed_copy.base.layers[0].visible)

    def test_reordering_and_renaming_do_not_change_ids_or_default(self):
        second = new_preset("しょんぼり", self.base)
        c = PresetCollection().append(self.normal).append(second)
        swapped = c.reorder((second.id, self.normal.id))
        self.assertEqual([p.id for p in swapped.presets], [second.id, self.normal.id])
        self.assertEqual(swapped.default_id, self.normal.id)
        changed = swapped.set_default(second.id).rename(second.id, "新しい名前")
        self.assertEqual(changed.default_id, second.id)
        self.assertEqual(changed.presets[0].id, second.id)
        self.assertEqual(c.presets[0].id, self.normal.id)

    def test_names_can_repeat_and_nfd_is_not_normalized(self):
        nfd = unicodedata.normalize("NFD", "だんもん")
        self.assertNotEqual(unicodedata.normalize("NFC", nfd), nfd)
        renamed = PresetCollection().append(self.normal).append(
            new_preset("通常", self.base)
        ).rename(self.normal.id, nfd)
        self.assertEqual(renamed.presets[0].name, nfd)
        self.assertEqual(renamed.presets[1].name, "通常")

    def test_invalid_layer_paths_and_duplicate_entries(self):
        for path in ((), (-1,), (0, -1), (True,), ("0",), [0]):
            with self.subTest(path=path), self.assertRaises(ValueError):
                LayerState(path, True)
        for on in (0, 1, None, "on"):
            with self.subTest(on=on), self.assertRaises(ValueError):
                LayerState((0,), on)
        with self.assertRaisesRegex(ValueError, "more than once"):
            state(((0,), True), ((0,), False))
        with self.assertRaisesRegex(ValueError, "immutable tuple"):
            LayerStateSet([LayerState((0,), True)])

    def test_invalid_ids_name_and_optional_shape_types(self):
        for id_ in ("", " ", None):
            with self.subTest(id_=id_), self.assertRaises(ValueError):
                Preset(id_, "name", self.base)
        with self.assertRaises(ValueError):
            Preset("valid", "", self.base)
        with self.assertRaises(ValueError):
            Preset("valid", "name", self.base, open_mouth={"closed": []})
        with self.assertRaises(ValueError):
            Preset("valid", "name", self.base, blink_enabled=1)
        with self.assertRaisesRegex(ValueError, "Mouth shapes"):
            OpenMouth([], state())
        with self.assertRaisesRegex(ValueError, "Aiueo shapes"):
            AiueoMouth(*([state()] * 5 + [[]]))
        with self.assertRaisesRegex(ValueError, "Eye shapes"):
            EyeStates(state(), [])

    def test_invalid_collection_default_duplicate_ids_and_refs(self):
        with self.assertRaisesRegex(ValueError, "Default"):
            PresetCollection((self.normal,), "unbound")
        with self.assertRaisesRegex(ValueError, "cannot have a default"):
            PresetCollection((), self.normal.id)
        with self.assertRaisesRegex(ValueError, "Duplicate preset ID"):
            PresetCollection((self.normal, self.normal), self.normal.id)
        with self.assertRaisesRegex(ValueError, "not found"):
            PresetCollection().append(self.normal).set_default("missing")
        with self.assertRaisesRegex(ValueError, "Duplicate preset ID"):
            PresetCollection().append(self.normal).append(self.normal)
        with self.assertRaisesRegex(ValueError, "Expected a preset"):
            PresetCollection().append(None)

    def test_reorder_rejects_missing_repeated_unknown_and_list_ids(self):
        second = new_preset("second", self.base)
        c = PresetCollection().append(self.normal).append(second)
        for order in (
            (self.normal.id,),
            (self.normal.id, self.normal.id),
            (self.normal.id, "missing"),
            [self.normal.id, second.id],
        ):
            with self.subTest(order=order), self.assertRaisesRegex(ValueError, "Reorder"):
                c.reorder(order)
        self.assertEqual(c.reorder((self.normal.id, second.id)), c)

    def test_no_visibility_evaluation_or_mutation_of_psd(self):
        # Only explicit values are stored; even a hidden parent or overlapping
        # mouth/eye target does NOT trigger an unapproved precedence rule here.
        base = state(((1,), False), ((1, 0), True))
        shape = state(((1, 0), False))
        preset = replace(self.normal, base=base,
                         open_mouth=OpenMouth(shape, shape),
                         eyes=EyeStates(shape, shape))
        self.assertEqual(preset.base.layers[0], LayerState((1,), False))
        self.assertEqual(preset.open_mouth.opened, preset.eyes.closed)
        self.assertEqual(preset.base.layers[1].visible, True)


if __name__ == "__main__":
    unittest.main()
