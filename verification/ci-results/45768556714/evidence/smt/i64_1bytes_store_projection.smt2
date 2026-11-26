; benchmark generated from python API
(set-info :status unknown)
(declare-fun logical_size () (_ BitVec 32))
(declare-fun addr () (_ BitVec 32))
(declare-fun base () (_ BitVec 32))
(declare-fun query () (_ BitVec 32))
(declare-fun physical () (Array (_ BitVec 32) (_ BitVec 8)))
(declare-fun logical () (Array (_ BitVec 32) (_ BitVec 8)))
(declare-fun value () (_ BitVec 64))
(assert
 (let ((?x15 ((_ zero_extend 32) logical_size)))
 (bvsle (bvadd ((_ zero_extend 32) addr) (_ bv1 64)) ?x15)))
(assert
 (bvsle (bvadd ((_ zero_extend 32) base) ((_ zero_extend 32) logical_size)) (_ bv4294967296 64)))
(assert
 (bvult query logical_size))
(assert
 (= (select logical query) (select physical (bvadd base query))))
(assert
 (let ((?x90 (bvadd base query)))
(let ((?x118 ((_ extract 7 0) value)))
(let ((?x24 (bvadd base addr)))
(let ((?x25 (bvadd ?x24 (_ bv0 32))))
(let ((?x54 (store physical ?x25 ?x118)))
(let ((?x43 ((_ extract 7 0) (bvudiv value (_ bv1 64)))))
(let ((?x22 (bvadd addr (_ bv0 32))))
(let ((?x7 (store logical ?x22 ?x43)))
(and (distinct (select ?x7 query) (select ?x54 ?x90)) true))))))))))
(check-sat)
