use jagua_rs::{entities::{Layout, Item}, geometry::DTransformation, io::{ext_repr::{ExtItem, ExtContainer}, import::Importer, export::export_layout_snapshot}};
use rand::{SeedableRng, rngs::Xoshiro256PlusPlus};
use serde::{Deserialize, Serialize};
use sparrow::{config::DEFAULT_SPARROW_CONFIG, eval::{lbf_evaluator::LBFEvaluator, sample_eval::{SampleEval, SampleEvaluator}}, sample::search::{search_placement, SampleConfig}};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct Input { item: ExtItem, containers: Vec<ExtContainer>, quantity: usize, separation: f32, seed: u64, samples: usize, #[serde(default = "compact_default")] compact: bool, #[serde(default)] grid: bool }
fn compact_default() -> bool { true }
#[derive(Serialize)]
struct Output { layouts: Vec<serde_json::Value>, outlines: Vec<Vec<Vec<(f32, f32)>>>, placed: usize }

struct CompactEvaluator<'a> {
    collision: LBFEvaluator<'a>,
    item: &'a Item,
    occupied: Option<[f32; 4]>,
    compact: bool,
}
impl<'a> CompactEvaluator<'a> {
    fn new(layout: &'a Layout, item: &'a Item, compact: bool) -> Self {
        let occupied = layout.placed_items().values().flat_map(|p| p.shape().vertices().iter().map(|v| (v.0, v.1))).fold(None, extend_bounds);
        Self { collision: LBFEvaluator::new(layout, item), item, occupied, compact }
    }
}
fn extend_bounds(bounds: Option<[f32; 4]>, (x, y): (f32, f32)) -> Option<[f32; 4]> {
    Some(match bounds {
        Some([left, bottom, right, top]) => [left.min(x), bottom.min(y), right.max(x), top.max(y)],
        None => [x, y, x, y],
    })
}
impl SampleEvaluator for CompactEvaluator<'_> {
    fn evaluate_sample(&mut self, transform: DTransformation, _: Option<SampleEval>) -> SampleEval {
        let result = self.collision.evaluate_sample(transform, None);
        if !self.compact { return result; }
        match result {
            SampleEval::Clear { .. } => {
                let (sin, cos) = transform.rotation().sin_cos();
                let (tx, ty) = transform.translation();
                let [left, bottom, right, top] = self.item.shape_cd().vertices().iter().map(|p| (tx + p.0*cos - p.1*sin, ty + p.0*sin + p.1*cos)).fold(self.occupied, extend_bounds).unwrap();
                SampleEval::Clear { loss: (right-left)+(top-bottom) + 0.001*(left+bottom) }
            },
            other => other,
        }
    }
    fn n_evals(&self) -> usize { self.collision.n_evals() }
}

#[wasm_bindgen]
pub fn nest(input: &str) -> Result<String, JsValue> {
    solve(input).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn solve(input: &str) -> Result<String, Box<dyn std::error::Error>> {
    let input: Input = serde_json::from_str(input)?;
    if input.quantity == 0 || input.quantity > 10000 || input.containers.len() > 50 || input.samples > 10000 { return Err("nesting limits exceeded".into()); }
    let importer = Importer::new(DEFAULT_SPARROW_CONFIG.cde_config, Some(0.001), None).with_min_item_separation(input.separation)?;
    let item = importer.import_item(&input.item, 0)?;
    let mut rng = Xoshiro256PlusPlus::seed_from_u64(input.seed);
    let config = SampleConfig { n_container_samples: input.samples, n_focussed_samples: 0, n_coord_descents: 8 };
    let mut output = Output { layouts: vec![], outlines: vec![], placed: 0 };
    for container in &input.containers {
        let mut layout = Layout::new(importer.import_container(container)?);
        while output.placed < input.quantity {
            let (candidate, _) = search_placement(&layout, &item, None, CompactEvaluator::new(&layout, &item, input.compact), config, &mut rng);
            match candidate {
                Some((transform, SampleEval::Clear { .. })) => {
                    let key = layout.place_item(&item, transform);
                    output.placed += 1;
                    if input.grid && layout.placed_items().len() == 1 {
                        let remaining = input.quantity - output.placed + 1;
                        let columns = (remaining as f32).sqrt().ceil() as usize;
                        let bbox = layout.placed_items()[key].shape().bbox();
                        let (x, y) = transform.translation();
                        for index in 1..remaining {
                            let candidate = DTransformation::new(transform.rotation(), (x + (index % columns) as f32 * (bbox.width() + 0.001), y + (index / columns) as f32 * (bbox.height() + 0.001)));
                            if matches!(LBFEvaluator::new(&layout, &item).evaluate_sample(candidate, None), SampleEval::Clear { .. }) {
                                layout.place_item(&item, candidate);
                                output.placed += 1;
                            }
                        }
                    }
                },
                _ => break,
            }
        }
        if input.quantity <= 16 && item.shape_cd().vertices().len() <= 64 {
            for _ in 0..2 {
                let keys = layout.placed_items().keys().collect::<Vec<_>>();
                for key in keys {
                    let previous = layout.remove_item(key).d_transf();
                    let baseline = CompactEvaluator::new(&layout, &item, true).evaluate_sample(previous, None);
                    let (candidate, _) = search_placement(&layout, &item, None, CompactEvaluator::new(&layout, &item, true), config, &mut rng);
                    let transform = match candidate {
                        Some((transform, eval @ SampleEval::Clear { .. })) if eval < baseline => transform,
                        _ => previous,
                    };
                    layout.place_item(&item, transform);
                }
            }
        }
        let outlines = layout.placed_items().values().map(|p| p.shape().vertices().iter().map(|v| (v.0, v.1)).collect()).collect();
        output.layouts.push(serde_json::to_value(export_layout_snapshot(&layout.save(), container.id))?);
        output.outlines.push(outlines);
        if output.placed == input.quantity { break; }
    }
    Ok(serde_json::to_string(&output)?)
}
