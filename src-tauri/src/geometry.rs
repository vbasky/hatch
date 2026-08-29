#[derive(Clone, Copy, Debug)]
pub struct Rect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Size {
  pub width: f64,
  pub height: f64,
}

pub const DEFAULT_WIDTH: f64 = 504.0;
pub const DEFAULT_HEIGHT: f64 = 620.0;
pub const MIN_HEIGHT: f64 = 220.0;
pub const MAX_HEIGHT: f64 = 720.0;
pub const MIN_WIDTH: f64 = 320.0;
const EDGE_PADDING: f64 = 8.0;

fn clamp(value: f64, min: f64, max: f64) -> f64 {
  if max < min {
    return min;
  }
  value.max(min).min(max)
}

pub fn to_logical(physical: Rect, scale: f64) -> Rect {
  let scale = if scale <= 0.0 { 1.0 } else { scale };
  Rect {
    x: physical.x / scale,
    y: physical.y / scale,
    width: physical.width / scale,
    height: physical.height / scale,
  }
}

pub fn calculate_popover_bounds(tray: Rect, work_area: Rect, size: Size) -> Rect {
  let tray_center_x = tray.x + tray.width / 2.0;
  let min_x = work_area.x + EDGE_PADDING;
  let max_x = work_area.x + work_area.width - size.width - EDGE_PADDING;
  let x = clamp(tray_center_x - size.width / 2.0, min_x, max_x).round();

  let below_y = tray.y + tray.height + EDGE_PADDING;
  let above_y = tray.y - size.height - EDGE_PADDING;
  let fits_below = below_y + size.height <= work_area.y + work_area.height;
  let y = if fits_below {
    below_y
  } else {
    clamp(
      above_y,
      work_area.y + EDGE_PADDING,
      work_area.y + work_area.height - size.height - EDGE_PADDING,
    )
  }
  .round();

  Rect {
    x,
    y,
    width: size.width,
    height: size.height,
  }
}

pub fn responsive_popover_size(content: Size, work_area: Option<Rect>) -> Size {
  let max_width = work_area
    .map(|area| MIN_WIDTH.max(area.width - EDGE_PADDING * 2.0))
    .unwrap_or(f64::INFINITY);
  let max_height = work_area
    .map(|area| MIN_HEIGHT.max(MAX_HEIGHT.min(area.height - EDGE_PADDING * 2.0)))
    .unwrap_or(MAX_HEIGHT);
  Size {
    width: clamp(content.width, MIN_WIDTH, max_width).ceil(),
    height: clamp(content.height, MIN_HEIGHT, max_height).ceil(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn retina_tray_converts_to_logical_before_placement() {
    let tray = to_logical(
      Rect {
        x: 2400.0,
        y: 0.0,
        width: 44.0,
        height: 44.0,
      },
      2.0,
    );
    let work_area = to_logical(
      Rect {
        x: 0.0,
        y: 0.0,
        width: 3024.0,
        height: 1964.0,
      },
      2.0,
    );
    assert_eq!(tray.x, 1200.0);
    assert_eq!(tray.width, 22.0);
    assert_eq!(work_area.width, 1512.0);

    let bounds = calculate_popover_bounds(
      tray,
      work_area,
      Size {
        width: 504.0,
        height: 320.0,
      },
    );
    assert_eq!(bounds.x, 971.0);
    assert_eq!(bounds.y, 30.0);
    assert!(bounds.x + bounds.width <= work_area.width);
  }
}
